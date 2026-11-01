import 'reflect-metadata';
import { expect, test } from 'bun:test';
import { GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { SqsQueueProbe } from '../../src/app/health/probes';

/** Dublê mínimo do SQSClient: registra os comandos e responde com valores fixos. */
class FakeSqs {
  readonly commands: Array<{ name: string; input: Record<string, unknown>; signal?: AbortSignal }> = [];
  constructor(private readonly failOn?: string) {}

  async send(command: { constructor: { name: string }; input: Record<string, unknown> }, options?: { abortSignal?: AbortSignal }) {
    const name = command.constructor.name;
    this.commands.push({ name, input: command.input, signal: options?.abortSignal });
    if (name === this.failOn) throw new Error(`${name} failed`);
    if (name === 'GetQueueUrlCommand') return { QueueUrl: `http://sqs.test/000000000000/${command.input.QueueName}` };
    return { Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:000000000000:q' } };
  }
}
const asSqs = (fake: FakeSqs) => fake as unknown as SQSClient;

test('the probe name is the one given (it appears as a key in the report)', () => {
  const probe = new SqsQueueProbe('sqsEvents', 'wager-events', asSqs(new FakeSqs()));
  expect(probe.name).toBe('sqsEvents');
});

test('checks the queue with metadata reads only: GetQueueUrl and GetQueueAttributes', async () => {
  const fake = new FakeSqs();
  await new SqsQueueProbe('sqsEvents', 'wager-events', asSqs(fake)).check(new AbortController().signal);

  expect(fake.commands.map((c) => c.name)).toEqual([GetQueueUrlCommand.name, GetQueueAttributesCommand.name]);
  expect(fake.commands[0]!.input.QueueName).toBe('wager-events');
  expect(fake.commands[1]!.input.QueueUrl).toBe('http://sqs.test/000000000000/wager-events');
  // Nada de Send/Receive/Delete: a probe não publica nem consome mensagens.
  expect(fake.commands.some((c) => /Send|Receive|Delete|Purge/.test(c.name))).toBe(false);
});

test('passes the AbortSignal to every SDK call (cancellation on deadline)', async () => {
  const fake = new FakeSqs();
  const controller = new AbortController();
  await new SqsQueueProbe('sqs', 'wager-transactions.fifo', asSqs(fake)).check(controller.signal);
  expect(fake.commands.every((c) => c.signal === controller.signal)).toBe(true);
});

test('rejects when the queue does not exist (GetQueueUrl fails)', async () => {
  const probe = new SqsQueueProbe('sqsEvents', 'wager-events', asSqs(new FakeSqs('GetQueueUrlCommand')));
  await expect(probe.check(new AbortController().signal)).rejects.toThrow('GetQueueUrlCommand failed');
});

test('rejects when the queue exists but its attributes are not readable', async () => {
  const probe = new SqsQueueProbe('sqsEvents', 'wager-events', asSqs(new FakeSqs('GetQueueAttributesCommand')));
  await expect(probe.check(new AbortController().signal)).rejects.toThrow('GetQueueAttributesCommand failed');
});
