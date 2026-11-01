import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ProcessWagerTransaction } from '../../src/app/wagering/application/process-wager-transaction.use-case';
import { WagerProcessor } from '../../src/app/wagering/domain/wager-processor';
import { WAGER_CONSUMER_NAME, type WagerConsumerOptions, WagerQueueConsumer } from '../../src/app/wagering/infrastructure/wager-queue.consumer';
import { MikroOrmUnitOfWork } from '../../src/database/mikro-orm-unit-of-work';
import { createPersistenceContext, PERSISTENCE_SCHEMAS } from '../../src/persistence.module';
import { systemClock, uuidV7Generator } from '../../src/shared/infrastructure/system-providers';
import { WorkerModule } from '../../src/worker.module';
import { type ApiCluster, holdWalletLock, startApiCluster, waitForBlockedSessions } from '../support/api-cluster';
import { testEnv } from '../support/env';
import { assertFinancialInvariants, movementsOf } from '../support/financial-invariants';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

// Requires `docker compose up -d postgres localstack`. Real PostgreSQL and real SQS: each test owns its
// database and queues. Crashes are reproduced at the exact point in this process; killing real processes
// is covered in test/concurrency/multiprocess.test.ts.
const TIMEOUT = 45_000;
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
let workers: INestApplicationContext[];

beforeEach(async () => {
  db = await createTestDatabase({ entities: PERSISTENCE_SCHEMAS });
  await db.orm.migrator.up();
  api = await startApiCluster(db, 1);
  workers = [];
  const id = randomUUID();
  names = { input: `consumer-test-${id}.fifo`, dlq: `consumer-test-${id}-dlq.fifo`, events: `consumer-test-${id}-events` };
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
});

afterEach(async () => {
  await Promise.all(workers.map((worker) => worker.close()));
  await api.close();
  await db.drop();
  for (const url of Object.values(urls)) await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
});

async function startWorker(overrides: Record<string, string> = {}): Promise<INestApplicationContext> {
  const worker = await NestFactory.createApplicationContext(
    WorkerModule.register(testEnv({
      DATABASE_URL: db.url,
      SQS_INPUT_QUEUE_NAME: names.input,
      SQS_DLQ_QUEUE_NAME: names.dlq,
      SQS_EVENTS_QUEUE_NAME: names.events,
      SQS_CONSUMER_WAIT_SECONDS: '1',
      SQS_CONSUMER_RETRY_BASE_SECONDS: '0',
      OUTBOX_POLL_INTERVAL_MS: '50',
      ...overrides,
    })),
    { logger: false },
  );
  await worker.init();
  workers.push(worker);
  return worker;
}

const brl = (amount: string) => ({ amount, currency: 'BRL' });

type OpenedWallet = { id: string; playerId: string };

async function openWallet(amount = '100.00'): Promise<OpenedWallet> {
  const reply = await api.call('POST', '/wallets', { playerId: randomUUID(), initialBalance: brl(amount) });
  expect(reply.status).toBe(201);
  return reply.body;
}

function data(wallet: OpenedWallet, kind: string, overrides: Record<string, unknown> = {}) {
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
    money: brl('25.00'),
    ...overrides,
  };
}

const envelope = (payload: unknown, messageId: string = randomUUID()) => ({
  messageId,
  type: 'WagerTransactionRequested',
  occurredAt: '2026-10-31T12:00:00.000Z',
  data: payload,
});

/** A fresh deduplication id on every send: repeated deliveries must be caught by the inbox, not by SQS. */
async function send(body: unknown, group: string = randomUUID()): Promise<void> {
  await sqs.send(new SendMessageCommand({
    QueueUrl: urls.input,
    MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
    MessageGroupId: group,
    MessageDeduplicationId: randomUUID(),
  }));
}

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await Bun.sleep(50);
  }
}

const transactionRows = (walletId: string) =>
  db.sql<any>(`SELECT id, status, failure_code, kind FROM wager_transactions WHERE wallet_id = ? AND kind <> 'OPENING'`, [walletId]);
const walletRow = async (id: string) =>
  (await db.sql<{ balance: string; version: number }>('SELECT balance::text AS balance, version FROM wallets WHERE id = ?', [id]))[0]!;
const inboxRow = async (messageId: string) =>
  (await db.sql<any>('SELECT * FROM inbox_messages WHERE consumer_name = ? AND message_id = ?', [WAGER_CONSUMER_NAME, messageId]))[0];
const inboxCount = async () => (await db.sql<{ n: number }>('SELECT count(*)::int AS n FROM inbox_messages'))[0]!.n;
const eventTypes = async (walletId: string) =>
  (await db.sql<{ event_type: string }>(`SELECT event_type FROM outbox_messages WHERE payload->'data'->>'walletId' = ? ORDER BY event_type`, [walletId])).map((e) => e.event_type);

async function inputDepth(): Promise<number> {
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl: urls.input,
    AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
  }));
  return Number(Attributes!.ApproximateNumberOfMessages) + Number(Attributes!.ApproximateNumberOfMessagesNotVisible);
}
const untilInputDrained = () => until(inputDepth, (depth) => depth === 0, 'the input queue to drain');

/** Reads and removes what reached the DLQ, waiting until `count` messages arrive. */
async function deadLetters(count: number) {
  const received: Array<{ body: string; reason?: string }> = [];
  const deadline = Date.now() + 25_000;
  while (received.length < count && Date.now() < deadline) {
    const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({ QueueUrl: urls.dlq, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageAttributeNames: ['All'] }));
    for (const message of Messages) {
      received.push({ body: message.Body!, reason: message.MessageAttributes?.failureReason?.StringValue });
      await sqs.send(new DeleteMessageCommand({ QueueUrl: urls.dlq, ReceiptHandle: message.ReceiptHandle! }));
    }
  }
  return received;
}

const dlqIsEmpty = async () => {
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: urls.dlq, AttributeNames: ['ApproximateNumberOfMessages'] }));
  return Number(Attributes!.ApproximateNumberOfMessages) === 0;
};

/** Makes PostgreSQL refuse a write in the middle of the transaction. No hook exists in production code. */
async function failOn(table: string, condition: string, sqlstate: string) {
  const name = `fail_${randomUUID().replaceAll('-', '')}`;
  await db.sql(`CREATE FUNCTION ${name}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected failure' USING ERRCODE = '${sqlstate}'; END; $$ LANGUAGE plpgsql`);
  await db.sql(`CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION ${name}()`);
  return async () => {
    await db.sql(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
    await db.sql(`DROP FUNCTION IF EXISTS ${name}()`);
  };
}

const failLedger = (walletId: string, sqlstate: string) =>
  failOn('wallet_ledger_entries', `NEW.wallet_id = '${walletId}' AND NEW.wallet_version > 1`, sqlstate);

/** The consumer alone, without the worker: closing the pool can't hide what the consumer itself does. */
function consumerWith(client: SQSClient, overrides: Partial<WagerConsumerOptions> = {}) {
  const useCase = new ProcessWagerTransaction(
    new MikroOrmUnitOfWork(db.orm, createPersistenceContext, 5000),
    new WagerProcessor(),
    systemClock,
    uuidV7Generator,
  );
  return new WagerQueueConsumer(client, useCase, {
    inputQueueName: names.input,
    dlqQueueName: names.dlq,
    batchSize: 10,
    waitSeconds: 1,
    retryBaseSeconds: 0,
    shutdownTimeoutMs: 5000,
    ...overrides,
  });
}

/** Long enough that a message only comes back early if the consumer returned it. */
const useLongVisibility = () =>
  sqs.send(new SetQueueAttributesCommand({ QueueUrl: urls.input, Attributes: { VisibilityTimeout: '120' } }));

async function inFlightCount(): Promise<number> {
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: urls.input, AttributeNames: ['ApproximateNumberOfMessagesNotVisible'] }));
  return Number(Attributes!.ApproximateNumberOfMessagesNotVisible);
}

describe('processing', () => {
  test('a valid message commits inbox, transaction, balance, ledger and outbox together, then is acknowledged', async () => {
    const wallet = await openWallet();
    await startWorker();
    const payload = data(wallet, 'BET');
    const message = envelope(payload);
    await send(message);

    await until(() => inboxRow(message.messageId), Boolean, 'the inbox row');
    await untilInputDrained();

    const [row] = await transactionRows(wallet.id);
    expect(row).toMatchObject({ status: 'PROCESSED', kind: 'BET' });
    const inbox = await inboxRow(message.messageId);
    expect(inbox.processed_at).not.toBeNull();
    expect(inbox.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await walletRow(wallet.id)).toEqual({ balance: '75.00', version: 2 });
    expect(await movementsOf(db, wallet.id)).toHaveLength(1);
    const [event] = await db.sql<any>(`SELECT payload FROM outbox_messages WHERE event_type = 'WalletBalanceChanged' AND payload->'data'->>'transactionId' = ?`, [row.id]);
    expect(event.payload).toMatchObject({ correlationId: message.messageId, causationId: message.messageId });
    await assertFinancialInvariants(db, wallet.id);
    expect(await dlqIsEmpty()).toBe(true);
  }, TIMEOUT);

  test('the same use case serves HTTP and SQS: an HTTP operation repeated through the queue is a replay', async () => {
    const wallet = await openWallet();
    const payload = data(wallet, 'BET');
    const { idempotencyKey, ...body } = payload;
    expect((await api.call('POST', '/wagering/transactions', body, { 'Idempotency-Key': idempotencyKey })).status).toBe(201);

    await startWorker();
    const message = envelope(payload);
    await send(message);
    await until(() => inboxRow(message.messageId), Boolean, 'the inbox row');
    await untilInputDrained();

    expect(await walletRow(wallet.id)).toEqual({ balance: '75.00', version: 2 });
    expect(await transactionRows(wallet.id)).toHaveLength(1);
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);

  test('operations from the same group run in order within a batch', async () => {
    const wallet = await openWallet();
    await startWorker();
    const bet = data(wallet, 'BET');
    await send(envelope(bet), wallet.id);
    await send(envelope(data(wallet, 'REFUND', { referenceExternalTransactionId: bet.externalTransactionId })), wallet.id);
    await send(envelope(data(wallet, 'LOSS')), wallet.id);

    await until(inboxCount, (n) => n === 3, 'three inbox rows');
    await untilInputDrained();
    expect((await transactionRows(wallet.id)).map((r: any) => r.status)).toEqual(['PROCESSED', 'PROCESSED', 'PROCESSED']);
    expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 3 });
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);
});

describe('deduplication', () => {
  test('the same messageId delivered twice has one effect and both deliveries are acknowledged', async () => {
    const wallet = await openWallet();
    const message = envelope(data(wallet, 'BET'));
    await send(message);
    await send(message);
    await startWorker();

    await until(() => inboxRow(message.messageId), Boolean, 'the inbox row');
    await untilInputDrained();
    const firstProcessedAt = (await inboxRow(message.messageId)).processed_at;

    expect(await walletRow(wallet.id)).toEqual({ balance: '75.00', version: 2 });
    expect(await transactionRows(wallet.id)).toHaveLength(1);
    expect(await inboxCount()).toBe(1);
    expect(firstProcessedAt).not.toBeNull();
    expect(await dlqIsEmpty()).toBe(true);
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);

  test('a later duplicate does not change when the message was processed', async () => {
    const wallet = await openWallet();
    await startWorker();
    const message = envelope(data(wallet, 'BET'));
    await send(message);
    await until(() => inboxRow(message.messageId), Boolean, 'the inbox row');
    await untilInputDrained();
    const { processed_at: processedAt } = await inboxRow(message.messageId);

    await send(message);
    await untilInputDrained();
    expect((await inboxRow(message.messageId)).processed_at).toEqual(processedAt);
    expect(await movementsOf(db, wallet.id)).toHaveLength(1);
  }, TIMEOUT);

  test('the same messageId with a conflicting payload goes to the DLQ and leaves the original intact', async () => {
    const wallet = await openWallet();
    await startWorker();
    const messageId = randomUUID();
    await send(envelope(data(wallet, 'BET'), messageId));
    await until(() => inboxRow(messageId), Boolean, 'the inbox row');
    await untilInputDrained();
    const original = await inboxRow(messageId);

    await send(envelope(data(wallet, 'BET', { money: brl('60.00') }), messageId));
    const [dead] = await deadLetters(1);
    expect(dead?.reason).toBe('INBOX_MESSAGE_CONFLICT');
    await untilInputDrained();

    expect(await inboxRow(messageId)).toEqual(original);
    expect(await walletRow(wallet.id)).toEqual({ balance: '75.00', version: 2 });
    expect(await transactionRows(wallet.id)).toHaveLength(1);
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);

  test('the same financial command under different messageIds has one effect and two inbox rows', async () => {
    const wallet = await openWallet();
    const payload = data(wallet, 'BET');
    const messages = [envelope(payload), envelope(payload)];
    await startWorker();
    await Promise.all(messages.map((message) => send(message)));

    await until(inboxCount, (n) => n === 2, 'two inbox rows');
    await untilInputDrained();
    expect(await walletRow(wallet.id)).toEqual({ balance: '75.00', version: 2 });
    expect(await transactionRows(wallet.id)).toHaveLength(1);
    expect(await dlqIsEmpty()).toBe(true);
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);
});

describe('concurrency', () => {
  test('three consumers on duplicates and many wallets: exact effects, without relying on FIFO order', async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => openWallet()));
    await Promise.all(Array.from({ length: 3 }, () => startWorker()));
    const repeated = data(wallets[0]!, 'BET');
    const repeatedMessage = envelope(repeated);

    await Promise.all([
      ...Array.from({ length: 10 }, () => send(repeatedMessage)),
      ...Array.from({ length: 10 }, () => send(envelope(repeated))),
      ...wallets.flatMap((wallet) => Array.from({ length: 3 }, () => send(envelope(data(wallet, 'BET', { money: brl('1.00') }))))),
    ]);

    await until(inboxCount, (n) => n === 26, 'all inbox rows');
    await untilInputDrained();
    expect(await walletRow(wallets[0]!.id)).toEqual({ balance: '72.00', version: 5 });
    for (const wallet of wallets.slice(1)) expect(await walletRow(wallet.id)).toEqual({ balance: '97.00', version: 4 });
    for (const wallet of wallets) await assertFinancialInvariants(db, wallet.id);
    expect(await dlqIsEmpty()).toBe(true);
  }, TIMEOUT);

  test('two BETs of 80.00 over 100.00 in different groups: one applied, one rejected, both acknowledged', async () => {
    await Promise.all(Array.from({ length: 2 }, () => startWorker()));
    for (let round = 0; round < 5; round++) {
      const wallet = await openWallet();
      await Promise.all(Array.from({ length: 2 }, () => send(envelope(data(wallet, 'BET', { money: brl('80.00') })))));
      await until(() => transactionRows(wallet.id), (rows) => rows.length === 2, 'both decisions');
      const rows = await transactionRows(wallet.id);
      expect(rows.map((r: any) => r.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
      expect(rows.find((r: any) => r.status === 'REJECTED').failure_code).toBe('INSUFFICIENT_FUNDS');
      expect(await walletRow(wallet.id)).toEqual({ balance: '20.00', version: 2 });
      await assertFinancialInvariants(db, wallet.id);
    }
    await untilInputDrained();
    expect(await dlqIsEmpty()).toBe(true);
  }, TIMEOUT);

  test('duplicates racing on the inbox insert, with the wallet held: exactly one effect', async () => {
    const wallet = await openWallet();
    const message = envelope(data(wallet, 'BET'));
    const lock = await holdWalletLock(db, wallet.id);
    await Promise.all(Array.from({ length: 2 }, () => startWorker()));
    await send(message);
    await send(message);
    await waitForBlockedSessions(db, 1);
    await lock.release();

    await until(() => inboxRow(message.messageId), Boolean, 'the inbox row');
    await untilInputDrained();
    expect(await movementsOf(db, wallet.id)).toHaveLength(1);
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);
});

describe('failures around the commit', () => {
  test('redelivery after the commit and before the ack does not repeat the effect', async () => {
    const wallet = await openWallet();
    const message = envelope(data(wallet, 'BET'));
    // The ack never reaches SQS, which is what a crash at this point would leave behind.
    const noAck = Object.assign(Object.create(sqs) as SQSClient, {
      send: (command: unknown, options?: any) =>
        command instanceof DeleteMessageCommand ? Promise.reject(new Error('crashed before the ack')) : sqs.send(command as any, options),
    });
    const crashing = consumerWith(noAck);
    await send(message);
    crashing.onApplicationBootstrap();
    await until(() => inboxRow(message.messageId), Boolean, 'the commit');
    await crashing.beforeApplicationShutdown();

    expect(await inputDepth()).toBe(1);
    expect(await walletRow(wallet.id)).toEqual({ balance: '75.00', version: 2 });

    await startWorker();
    await untilInputDrained();
    expect(await walletRow(wallet.id)).toEqual({ balance: '75.00', version: 2 });
    expect(await movementsOf(db, wallet.id)).toHaveLength(1);
    expect(await inboxCount()).toBe(1);
    expect((await eventTypes(wallet.id)).filter((type) => type === 'WalletBalanceChanged')).toHaveLength(2); // opening and BET
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);

  test('a transient failure before the commit leaves nothing behind, and the retry applies once', async () => {
    const wallet = await openWallet();
    const heal = await failLedger(wallet.id, '55P03');
    const message = envelope(data(wallet, 'BET'));
    await startWorker({ SQS_CONSUMER_RETRY_BASE_SECONDS: '1' });
    await send(message);

    await until(async () => {
      const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: urls.input, AttributeNames: ['ApproximateNumberOfMessagesNotVisible'] }));
      return Number(Attributes!.ApproximateNumberOfMessagesNotVisible);
    }, (n) => n > 0, 'the first attempt');
    expect(await inboxRow(message.messageId)).toBeUndefined();
    expect(await transactionRows(wallet.id)).toHaveLength(0);
    expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 1 });
    expect(await eventTypes(wallet.id)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']); // opening only
    await heal();

    await until(() => inboxRow(message.messageId), Boolean, 'the successful retry');
    await untilInputDrained();
    expect(await walletRow(wallet.id)).toEqual({ balance: '75.00', version: 2 });
    expect(await dlqIsEmpty()).toBe(true);
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);

  test('an unexpected database error is retried instead of being discarded', async () => {
    const wallet = await openWallet();
    const heal = await failLedger(wallet.id, 'P0001');
    const message = envelope(data(wallet, 'BET'));
    await startWorker({ SQS_CONSUMER_RETRY_BASE_SECONDS: '1' });
    await send(message);
    await Bun.sleep(300);
    expect(await inputDepth()).toBe(1);
    expect(await transactionRows(wallet.id)).toHaveLength(0);
    await heal();
    await until(() => inboxRow(message.messageId), Boolean, 'the successful retry');
    await untilInputDrained();
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);

  test('a persistent transient failure reaches the DLQ through the redrive policy, with no partial effect', async () => {
    const wallet = await openWallet();
    await failLedger(wallet.id, '55P03');
    const message = envelope(data(wallet, 'BET'));
    await startWorker();
    await send(message);

    const dead = await deadLetters(1);
    expect(dead).toHaveLength(1);
    expect(JSON.parse(dead[0]!.body).messageId).toBe(message.messageId);
    expect(dead[0]!.reason).toBeUndefined(); // moved by SQS itself, not by the consumer
    await untilInputDrained();
    expect(await inboxRow(message.messageId)).toBeUndefined();
    expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 1 });
    expect(await transactionRows(wallet.id)).toHaveLength(0);
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);

  test('a permanent database failure records FAILED and goes straight to the DLQ; its redelivery too', async () => {
    const wallet = await openWallet();
    await failLedger(wallet.id, '23514');
    const message = envelope(data(wallet, 'BET'));
    await startWorker();
    await send(message);

    const [first] = await deadLetters(1);
    expect(first?.reason).toBe('INTERNAL_ERROR');
    await untilInputDrained();
    expect((await transactionRows(wallet.id))[0]).toMatchObject({ status: 'FAILED', failure_code: 'INTERNAL_ERROR' });
    expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 1 });

    await send(first!.body);
    const [second] = await deadLetters(1);
    expect(second?.reason).toBe('INTERNAL_ERROR');
    expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 1 });
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);
});

describe('classification', () => {
  test('a business rejection is terminal, audited in the inbox, and acknowledged without retry', async () => {
    const wallet = await openWallet('10.00');
    await startWorker();
    const message = envelope(data(wallet, 'BET'));
    await send(message);

    await until(() => inboxRow(message.messageId), Boolean, 'the inbox row');
    await untilInputDrained();
    expect((await transactionRows(wallet.id))[0]).toMatchObject({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect(await eventTypes(wallet.id)).toContain('WagerTransactionRejected');
    expect(await dlqIsEmpty()).toBe(true);
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);

  test.each<[string, (wallet: OpenedWallet) => unknown]>([
    ['malformed JSON', () => '{"messageId":'],
    ['an unknown type', (wallet) => ({ ...envelope(data(wallet, 'BET')), type: 'SomethingElse' })],
    ['a missing field', (wallet) => { const { walletId, ...rest } = data(wallet, 'BET'); return envelope(rest); }],
    ['an unknown field', (wallet) => ({ ...envelope(data(wallet, 'BET')), extra: true })],
    ['an invalid amount', (wallet) => envelope(data(wallet, 'BET', { money: brl('25') }))],
    ['a numeric amount', (wallet) => envelope(data(wallet, 'BET', { money: { amount: 25, currency: 'BRL' } }))],
    ['an external OPENING', (wallet) => envelope(data(wallet, 'OPENING'))],
    ['the reserved provider', (wallet) => envelope(data(wallet, 'BET', { providerId: 'internal' }))],
    ['a REFUND without a reference', (wallet) => envelope(data(wallet, 'REFUND'))],
    ['a zero-value BET', (wallet) => envelope(data(wallet, 'BET', { money: brl('0.00') }))],
  ])('%s goes straight to the DLQ with its original body, and nothing is written', async (_name, build) => {
    const wallet = await openWallet();
    await startWorker();
    const body = build(wallet);
    await send(body);

    const dead = await deadLetters(1);
    expect(dead).toHaveLength(1);
    expect(dead[0]!.reason).toBe('INVALID_MESSAGE');
    expect(dead[0]!.body).toBe(typeof body === 'string' ? body : JSON.stringify(body));
    await untilInputDrained();
    expect(await inboxCount()).toBe(0);
    expect(await transactionRows(wallet.id)).toHaveLength(0);
    expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 1 });
  }, TIMEOUT);

  test('an unknown wallet goes to the DLQ without being persisted', async () => {
    const wallet = await openWallet();
    await startWorker();
    await send(envelope(data(wallet, 'BET', { walletId: randomUUID() })));
    const [dead] = await deadLetters(1);
    expect(dead?.reason).toBe('WALLET_NOT_FOUND');
    await untilInputDrained();
    expect(await inboxCount()).toBe(0);
  }, TIMEOUT);

  test('an idempotency conflict goes to the DLQ instead of being acknowledged silently', async () => {
    const wallet = await openWallet();
    await startWorker();
    const idempotencyKey = randomUUID();
    const first = envelope(data(wallet, 'BET', { idempotencyKey }));
    await send(first);
    await until(() => inboxRow(first.messageId), Boolean, 'the first operation');

    const conflicting = envelope(data(wallet, 'BET', { idempotencyKey, money: brl('60.00') }));
    await send(conflicting);
    const [dead] = await deadLetters(1);
    expect(dead?.reason).toBe('IDEMPOTENCY_KEY_REUSED');
    await untilInputDrained();
    expect(await inboxRow(conflicting.messageId)).toBeUndefined();
    expect(await walletRow(wallet.id)).toEqual({ balance: '75.00', version: 2 });
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);
});

describe('out-of-order delivery', () => {
  test('a REFUND before its reference stays pending with no movement, and is acknowledged', async () => {
    const wallet = await openWallet();
    await startWorker();
    const betId = randomUUID();
    const refund = envelope(data(wallet, 'REFUND', { referenceExternalTransactionId: betId }));
    await send(refund);

    await until(() => inboxRow(refund.messageId), Boolean, 'the inbox row');
    await untilInputDrained();
    expect((await transactionRows(wallet.id))[0]).toMatchObject({ status: 'PENDING_REFERENCE', kind: 'REFUND' });
    expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 1 });
    expect(await movementsOf(db, wallet.id)).toHaveLength(0);
    expect(await eventTypes(wallet.id)).toContain('WagerTransactionPendingReference');

    // Resolving it later is the retrier's job (see pending-reference-retrier.test.ts): the referenced BET applies on its own.
    const bet = envelope(data(wallet, 'BET', { externalTransactionId: betId }));
    await send(bet);
    await until(() => inboxRow(bet.messageId), Boolean, 'the BET');
    await untilInputDrained();
    expect((await transactionRows(wallet.id)).map((r: any) => r.status).sort()).toEqual(['PENDING_REFERENCE', 'PROCESSED']);
    expect(await walletRow(wallet.id)).toEqual({ balance: '75.00', version: 2 });
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);
});

describe('graceful shutdown', () => {
  test('a message in progress is finished and acknowledged during shutdown', async () => {
    const wallet = await openWallet();
    const lock = await holdWalletLock(db, wallet.id);
    const worker = await startWorker({ SQS_CONSUMER_SHUTDOWN_TIMEOUT_MS: '15000' });
    const message = envelope(data(wallet, 'BET'));
    await send(message);
    await waitForBlockedSessions(db, 1);

    workers.splice(workers.indexOf(worker), 1);
    let closed = false;
    const closing = worker.close().then(() => { closed = true; });
    await Bun.sleep(200);
    expect(closed).toBe(false); // waits for the message instead of abandoning it
    await lock.release();
    await closing;

    expect((await inboxRow(message.messageId)).processed_at).not.toBeNull();
    expect(await inputDepth()).toBe(0);
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);

  test('past the shutdown deadline the message is not acknowledged, and another worker processes it once', async () => {
    const wallet = await openWallet();
    const lock = await holdWalletLock(db, wallet.id);
    const worker = await startWorker({ SQS_CONSUMER_SHUTDOWN_TIMEOUT_MS: '100', DB_LOCK_TIMEOUT_MS: '500' });
    const message = envelope(data(wallet, 'BET'));
    await send(message);
    await waitForBlockedSessions(db, 1);

    workers.splice(workers.indexOf(worker), 1);
    await worker.close();
    await lock.release();
    expect(await inboxRow(message.messageId)).toBeUndefined();

    await startWorker();
    await until(() => inboxRow(message.messageId), Boolean, 'processing by the next worker');
    await untilInputDrained();
    expect(await movementsOf(db, wallet.id)).toHaveLength(1);
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);

  test('a message from the batch that never started returns to the queue immediately', async () => {
    await useLongVisibility();
    const wallet = await openWallet();
    const lock = await holdWalletLock(db, wallet.id);
    const first = envelope(data(wallet, 'BET'));
    const second = envelope(data(wallet, 'LOSS'));
    await send(first, wallet.id);
    await send(second, wallet.id);
    const consumer = consumerWith(sqs, { shutdownTimeoutMs: 15_000 });
    consumer.onApplicationBootstrap();
    await waitForBlockedSessions(db, 1);
    await until(inFlightCount, (count) => count === 2, 'both messages in the same batch');

    const stopping = consumer.beforeApplicationShutdown();
    await lock.release();
    await stopping;

    expect((await inboxRow(first.messageId)).processed_at).not.toBeNull();
    expect(await inboxRow(second.messageId)).toBeUndefined();
    expect(await inFlightCount()).toBe(0); // with a 120 s visibility, only an explicit return explains this

    await startWorker();
    await until(() => inboxRow(second.messageId), Boolean, 'the returned message to be processed', 10_000);
    await untilInputDrained();
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);

  test('shutdown waits for the message in progress, and by then it is committed and acknowledged', async () => {
    await useLongVisibility();
    const wallet = await openWallet();
    const lock = await holdWalletLock(db, wallet.id);
    const message = envelope(data(wallet, 'BET'));
    await send(message);
    const consumer = consumerWith(sqs, { shutdownTimeoutMs: 15_000 });
    consumer.onApplicationBootstrap();
    await waitForBlockedSessions(db, 1);

    let finished = false;
    const stopping = consumer.beforeApplicationShutdown().then(() => { finished = true; });
    await Bun.sleep(300);
    expect(finished).toBe(false);

    await lock.release();
    await stopping;
    expect((await inboxRow(message.messageId)).processed_at).not.toBeNull();
    expect(await inputDepth()).toBe(0);
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);

  test('shutdown respects its deadline, and the unfinished message is not acknowledged', async () => {
    await useLongVisibility();
    const wallet = await openWallet();
    const lock = await holdWalletLock(db, wallet.id);
    const message = envelope(data(wallet, 'BET'));
    await send(message);
    const consumer = consumerWith(sqs, { shutdownTimeoutMs: 200 });
    consumer.onApplicationBootstrap();
    await waitForBlockedSessions(db, 1);

    const startedAt = Date.now();
    await consumer.beforeApplicationShutdown();
    expect(Date.now() - startedAt).toBeLessThan(2000); // the wallet lock is still held
    expect(await inboxRow(message.messageId)).toBeUndefined();
    expect(await inputDepth()).toBe(1);

    await lock.release();
    await until(() => inboxRow(message.messageId), Boolean, 'the message that was already running');
    // At the deadline the unfinished message was handed back to the queue, so the late ack of the old handler may
    // not delete it. Another consumer then receives it again, finds it already applied, and acknowledges it.
    const next = consumerWith(sqs);
    next.onApplicationBootstrap();
    try {
      await untilInputDrained();
    } finally {
      await next.beforeApplicationShutdown();
    }
    expect((await movementsOf(db, wallet.id)).length).toBe(1);
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);

  test('shutdown interrupts the long poll instead of waiting for it', async () => {
    const consumer = consumerWith(sqs, { waitSeconds: 20, shutdownTimeoutMs: 15_000 });
    consumer.onApplicationBootstrap();
    await Bun.sleep(500); // lets the receive call reach SQS

    const startedAt = Date.now();
    await consumer.beforeApplicationShutdown();
    expect(Date.now() - startedAt).toBeLessThan(2000);

    const wallet = await openWallet();
    const message = envelope(data(wallet, 'BET'));
    await send(message);
    await Bun.sleep(1500);
    expect(await inboxRow(message.messageId)).toBeUndefined();
    expect(await inputDepth()).toBe(1);
  }, TIMEOUT);

  test('shutdown stops receiving: a message sent afterwards stays in the queue', async () => {
    const worker = await startWorker();
    workers.splice(workers.indexOf(worker), 1);
    await worker.close();
    const wallet = await openWallet();
    const message = envelope(data(wallet, 'BET'));
    await send(message);
    await Bun.sleep(1500);
    expect(await inputDepth()).toBe(1);
    expect(await inboxRow(message.messageId)).toBeUndefined();
  }, TIMEOUT);
});

describe('coexistence with the outbox publisher', () => {
  test('events go to the events queue, carry the messageId as causation, and never return as commands', async () => {
    const wallet = await openWallet();
    await startWorker();
    const message = envelope(data(wallet, 'BET'));
    await send(message);
    await until(() => inboxRow(message.messageId), Boolean, 'the inbox row');
    await untilInputDrained();

    const bodies: any[] = [];
    const deadline = Date.now() + 15_000;
    while (bodies.length < 4 && Date.now() < deadline) {
      const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({ QueueUrl: urls.events, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
      for (const received of Messages) {
        bodies.push(JSON.parse(received.Body!));
        await sqs.send(new DeleteMessageCommand({ QueueUrl: urls.events, ReceiptHandle: received.ReceiptHandle! }));
      }
    }
    expect(bodies).toHaveLength(4); // opening (2) and BET (2)
    expect(bodies.filter((b) => b.causationId === message.messageId).map((b) => b.eventType).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(await inputDepth()).toBe(0);
    expect(await inboxCount()).toBe(1);
    expect(await dlqIsEmpty()).toBe(true);
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);
});
