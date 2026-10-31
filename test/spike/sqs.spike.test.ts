import { expect, test } from 'bun:test';
import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

// Pré-requisito: `docker compose up -d postgres localstack` (filas criadas pelo init-queues.sh).
const sqs = new SQSClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

const queueUrl = async (name: string) =>
  (await sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;

test('SQS: filas FIFO existem e a redrive policy aponta para a DLQ', async () => {
  const url = await queueUrl('wager-transactions.fifo');
  const attrs = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['All'] }))).Attributes!;
  expect(attrs.FifoQueue).toBe('true');
  const redrive = JSON.parse(attrs.RedrivePolicy!);
  expect(redrive.deadLetterTargetArn).toContain('wager-transactions-dlq.fifo');
  expect(Number(redrive.maxReceiveCount)).toBe(5);
  await queueUrl('wager-transactions-dlq.fifo');
  await queueUrl('wager-events');
});

test('SQS: envia, recebe e apaga uma mensagem FIFO', async () => {
  const url = await queueUrl('wager-transactions.fifo');
  const messageId = `spike-${crypto.randomUUID()}`;
  await sqs.send(new SendMessageCommand({
    QueueUrl: url,
    MessageBody: JSON.stringify({ messageId }),
    MessageGroupId: 'wallet-spike',
    MessageDeduplicationId: messageId,
  }));
  const res = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, WaitTimeSeconds: 5, MaxNumberOfMessages: 1 }));
  expect(JSON.parse(res.Messages![0]!.Body!).messageId).toBe(messageId);
  await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: res.Messages![0]!.ReceiptHandle! }));
});
