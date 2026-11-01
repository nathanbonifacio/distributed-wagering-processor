import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { type INestApplicationContext, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PERSISTENCE_SCHEMAS } from '../../src/persistence.module';
import { AppMetrics } from '../../src/shared/observability/app-metrics';
import { JsonLogger } from '../../src/shared/observability/json-logger';
import { WorkerModule } from '../../src/worker.module';
import { type ApiCluster, holdWalletLock, startApiCluster } from '../support/api-cluster';
import { testEnv } from '../support/env';
import { assertFinancialInvariants } from '../support/financial-invariants';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

// Requires `docker compose up -d postgres localstack`. A real worker over real PostgreSQL and real SQS,
// with its own queues. What is asserted is what the worker's own metrics and logger produce.
const MAX_RECEIVE_COUNT = 3;
const env = testEnv();
const sqs = new SQSClient({
  region: env.AWS_REGION,
  endpoint: env.SQS_ENDPOINT,
  credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID!, secretAccessKey: env.AWS_SECRET_ACCESS_KEY! },
  maxAttempts: 1,
});

let db: TestDatabase;
let api: ApiCluster;
let names: { input: string; dlq: string; events: string };
let urls: { input: string; dlq: string; events: string };
let worker: INestApplicationContext | undefined;
let lines: Array<Record<string, any>> = [];

beforeEach(async () => {
  db = await createTestDatabase({ entities: PERSISTENCE_SCHEMAS });
  await db.orm.migrator.up();
  api = await startApiCluster(db, 1, { PENDING_REFERENCE_RETRY_BASE_MS: '60', PENDING_REFERENCE_RETRY_MAX_MS: '120' });
  const id = randomUUID();
  names = { input: `obs-${id}.fifo`, dlq: `obs-${id}-dlq.fifo`, events: `obs-${id}-events` };
  const dlq = (await sqs.send(new CreateQueueCommand({ QueueName: names.dlq, Attributes: { FifoQueue: 'true' } }))).QueueUrl!;
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }));
  const input = (await sqs.send(new CreateQueueCommand({
    QueueName: names.input,
    Attributes: {
      FifoQueue: 'true',
      VisibilityTimeout: '1',
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: Attributes!.QueueArn, maxReceiveCount: String(MAX_RECEIVE_COUNT) }),
    },
  }))).QueueUrl!;
  const events = (await sqs.send(new CreateQueueCommand({ QueueName: names.events }))).QueueUrl!;
  urls = { input, dlq, events };
  lines = [];
});

afterEach(async () => {
  Logger.overrideLogger(false);
  await worker?.close();
  worker = undefined;
  await api.close();
  await db.drop();
  for (const url of Object.values(urls)) await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
});

async function startWorker(overrides: Record<string, string> = {}): Promise<AppMetrics> {
  worker = await NestFactory.createApplicationContext(
    WorkerModule.register(testEnv({
      DATABASE_URL: db.url,
      SQS_INPUT_QUEUE_NAME: names.input,
      SQS_DLQ_QUEUE_NAME: names.dlq,
      SQS_EVENTS_QUEUE_NAME: names.events,
      SQS_CONSUMER_WAIT_SECONDS: '1',
      SQS_CONSUMER_RETRY_BASE_SECONDS: '0',
      OUTBOX_POLL_INTERVAL_MS: '50',
      PENDING_REFERENCE_POLL_INTERVAL_MS: '20',
      PENDING_REFERENCE_RETRY_BASE_MS: '60',
      PENDING_REFERENCE_RETRY_MAX_MS: '120',
      PENDING_REFERENCE_MAX_ATTEMPTS: '1000',
      ...overrides,
    })),
    { logger: false },
  );
  // The factory resets the static logger, so the capture starts only now.
  Logger.overrideLogger(new JsonLogger({ write: (line) => lines.push(JSON.parse(line)) }, 'debug'));
  await worker.init();
  return worker.get(AppMetrics);
}

async function until<T>(read: () => Promise<T> | T, accept: (value: T) => boolean, what: string, timeoutMs = 25_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await Bun.sleep(50);
  }
}

/** Value of one sample, or 0 when it has not been emitted yet. */
async function sample(metrics: AppMetrics, selector: string): Promise<number> {
  const line = (await metrics.render()).split('\n').find((candidate) => candidate.startsWith(`${selector} `));
  return line ? Number(line.slice(selector.length + 1)) : 0;
}

const money = (amount: string) => ({ amount, currency: 'BRL' });
async function openWallet(amount = '100.00') {
  const reply = await api.call('POST', '/wallets', { playerId: randomUUID(), initialBalance: money(amount) });
  expect(reply.status).toBe(201);
  return reply.body as { id: string; playerId: string };
}
const data = (wallet: { id: string; playerId: string }, kind: string, overrides: Record<string, unknown> = {}) => {
  const externalTransactionId = (overrides.externalTransactionId as string) ?? randomUUID();
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: money('25.00'),
    ...overrides,
  };
};
/** The HTTP body has no idempotencyKey: it travels in the header. */
const httpBody = ({ idempotencyKey: _ignored, ...rest }: ReturnType<typeof data>) => rest;
const envelope = (payload: unknown, messageId: string = randomUUID()) => ({
  messageId,
  type: 'WagerTransactionRequested',
  occurredAt: '2026-11-01T12:00:00.000Z',
  data: payload,
});
const send = (body: unknown, group: string = randomUUID()) =>
  sqs.send(new SendMessageCommand({
    QueueUrl: urls.input,
    MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
    MessageGroupId: group,
    MessageDeduplicationId: randomUUID(),
  }));
const walletBalance = async (id: string) => (await db.sql<{ balance: string }>('SELECT balance::text AS balance FROM wallets WHERE id = ?', [id]))[0]!.balance;

describe('SQS consumer', () => {
  test('a processed message is counted as sqs, and every record carries its messageId as correlation', async () => {
    const metrics = await startWorker();
    const wallet = await openWallet();
    const messageId = `msg-${randomUUID()}`;
    await send(envelope(data(wallet, 'BET'), messageId));

    await until(() => walletBalance(wallet.id), (balance) => balance === '75.00', 'the BET to be applied');
    await until(() => sample(metrics, 'wager_transactions_total{source="sqs",kind="BET",status="PROCESSED"}'), (n) => n === 1, 'the sqs counter');
    expect(await sample(metrics, 'wager_processing_duration_seconds_count{source="sqs"}')).toBe(1);

    const handled = lines.find((line) => line.msg === 'transaction handled' && line.source === 'sqs');
    expect(handled).toMatchObject({ messageId, correlationId: messageId, walletId: wallet.id, providerId: 'provider-a', status: 'PROCESSED', kind: 'BET' });
    expect(handled?.transactionId).toBeString();
    // The events written by this message share the same correlation id.
    const events = await db.sql(`SELECT payload FROM outbox_messages WHERE payload->>'correlationId' = ?`, [messageId]);
    expect(events.length).toBeGreaterThan(0);
    await assertFinancialInvariants(db, wallet.id);
  });

  test('a redelivered message is counted as a duplicate and logged, with a single debit', async () => {
    const metrics = await startWorker();
    const wallet = await openWallet();
    const messageId = `msg-${randomUUID()}`;
    const message = envelope(data(wallet, 'BET'), messageId);
    await send(message);
    await send(message, randomUUID());
    await send(message, randomUUID());

    await until(() => sample(metrics, 'wager_duplicates_total{type="inbox_message"}'), (n) => n === 2, 'two duplicates to be detected');
    expect(await walletBalance(wallet.id)).toBe('75.00');
    const duplicates = lines.filter((line) => line.msg === 'duplicate message ignored');
    expect(duplicates).toHaveLength(2);
    for (const line of duplicates) expect(line).toMatchObject({ messageId, consumerName: 'wager-transactions-consumer', walletId: wallet.id });
    await assertFinancialInvariants(db, wallet.id);
  });

  test('an unreadable message goes to the DLQ: counted by reason, logged, and visible in the queue depth gauge', async () => {
    const metrics = await startWorker();
    await send('this is not json');

    await until(() => sample(metrics, 'wager_dlq_messages_total{reason="INVALID_MESSAGE"}'), (n) => n === 1, 'the DLQ counter');
    const moved = lines.find((line) => line.msg === 'moving message to the DLQ');
    expect(moved).toMatchObject({ level: 'warn', reason: 'INVALID_MESSAGE', receiveCount: 1 });
    expect(moved?.messageId).toBeString();
    expect(JSON.stringify(lines)).not.toContain('this is not json');
    await until(() => sample(metrics, 'wager_dlq_depth'), (depth) => depth === 1, 'the DLQ depth gauge');
  });

  test('a lock timeout is counted as a lock conflict, schedules a redelivery, and the message succeeds once the lock is free', async () => {
    const metrics = await startWorker({ DB_LOCK_TIMEOUT_MS: '150' });
    const wallet = await openWallet();
    const lock = await holdWalletLock(db, wallet.id);
    const messageId = `msg-${randomUUID()}`;
    await send(envelope(data(wallet, 'BET'), messageId));

    await until(() => sample(metrics, 'wager_lock_conflicts_total{type="lock_timeout"}'), (n) => n >= 1, 'a lock timeout');
    await until(() => sample(metrics, 'wager_retries_total{kind="sqs_redelivery"}'), (n) => n >= 1, 'a scheduled redelivery');
    await lock.release();

    await until(() => walletBalance(wallet.id), (balance) => balance === '75.00', 'the redelivered BET to be applied');
    const retry = lines.find((line) => line.msg === 'processing failed: redelivery scheduled');
    expect(retry).toMatchObject({ level: 'warn', messageId, correlationId: messageId, receiveCount: 1, delaySeconds: 0 });
    expect(lines.find((line) => line.msg === 'transaction failed on a lock conflict')).toMatchObject({ reason: 'lock_timeout' });
    expect(await sample(metrics, 'wager_wallet_lock_wait_seconds_count')).toBeGreaterThan(0);
    await assertFinancialInvariants(db, wallet.id);
  });
});

describe('pending references', () => {
  test('a reversal whose reference never arrives is counted as a retry and logged with the transaction id as correlation', async () => {
    const metrics = await startWorker();
    const wallet = await openWallet();
    const refund = await api.call('POST', '/wagering/transactions', httpBody(data(wallet, 'REFUND', { referenceExternalTransactionId: 'does-not-exist' })), {
      'Idempotency-Key': `provider-a:${randomUUID()}`,
    });
    expect(refund.status).toBe(202);

    await until(() => sample(metrics, 'wager_retries_total{kind="pending_reference"}'), (n) => n >= 2, 'two rescheduled retries');
    const line = lines.find((candidate) => candidate.msg === 'reference still missing: retry rescheduled');
    expect(line).toMatchObject({ transactionId: refund.body.transactionId, correlationId: refund.body.transactionId, walletId: wallet.id, providerId: 'provider-a' });
    expect(line?.attempts).toBeGreaterThanOrEqual(1);
    // Waiting for the reference never counts as a decided transaction.
    expect(await sample(metrics, 'wager_transactions_total{source="retry",kind="REFUND",status="PENDING_REFERENCE"}')).toBe(0);
    expect(await walletBalance(wallet.id)).toBe('100.00');
  });

  test('a reference that arrives later settles the reversal, counted as a retry-sourced transaction', async () => {
    const metrics = await startWorker();
    const wallet = await openWallet();
    const bet = data(wallet, 'BET');
    const refund = await api.call('POST', '/wagering/transactions', httpBody(data(wallet, 'REFUND', { referenceExternalTransactionId: bet.externalTransactionId })), {
      'Idempotency-Key': `provider-a:${randomUUID()}`,
    });
    expect(refund.status).toBe(202);
    expect((await api.call('POST', '/wagering/transactions', httpBody(bet), { 'Idempotency-Key': bet.idempotencyKey })).status).toBe(201);

    await until(() => sample(metrics, 'wager_transactions_total{source="retry",kind="REFUND",status="PROCESSED"}'), (n) => n === 1, 'the retry to settle');
    expect(await walletBalance(wallet.id)).toBe('100.00');
    await assertFinancialInvariants(db, wallet.id);
  });
});

describe('outbox', () => {
  test('events that cannot be published are counted as retries and show up as pending and as lag', async () => {
    const metrics = await startWorker({ SQS_EVENTS_QUEUE_NAME: `missing-${randomUUID()}` });
    await openWallet();

    await until(() => sample(metrics, 'wager_retries_total{kind="outbox_publish"}'), (n) => n >= 1, 'a failed publication');
    expect(await sample(metrics, 'wager_outbox_pending')).toBeGreaterThanOrEqual(1);
    await until(() => sample(metrics, 'wager_outbox_lag_seconds'), (lag) => lag > 0, 'a positive outbox lag');
    expect(lines.find((line) => line.msg === 'outbox batch handled')).toMatchObject({ level: 'warn', published: 0 });
    expect(await sample(metrics, 'wager_outbox_published_total')).toBe(0);
  });

  test('published events lower the lag back to zero and are counted', async () => {
    const metrics = await startWorker();
    await openWallet();
    await until(() => sample(metrics, 'wager_outbox_published_total'), (n) => n >= 1, 'the events to be published');
    await until(() => sample(metrics, 'wager_outbox_pending'), (n) => n === 0, 'no pending events');
    expect(await sample(metrics, 'wager_outbox_lag_seconds')).toBe(0);
    expect(lines.find((line) => line.msg === 'outbox batch handled')).toMatchObject({ level: 'info', failed: 0 });
  });
});
