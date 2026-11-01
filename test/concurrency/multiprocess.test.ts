import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { PERSISTENCE_SCHEMAS } from '../../src/persistence.module';
import { type AppProcess, startAppProcess } from '../support/app-process';
import { holdWalletLock, waitForBlockedSessions } from '../support/api-cluster';
import { testEnv } from '../support/env';
import { assertFinancialInvariants, movementsOf } from '../support/financial-invariants';
import { startSqsGate, type SqsGate } from '../support/sqs-gate';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

// README section 13, "Concurrency": every scenario runs REAL operating system processes (bun run src/main.api.ts and
// src/main.worker.ts) against one real PostgreSQL and one real SQS. Nothing is shared with the test but those two
// services. Processes are killed with real signals at exact points, and waiting is always on observable state with a
// deadline, never on a fixed sleep. Requires `docker compose up -d postgres localstack`.
const env = testEnv();
const sqs = new SQSClient({
  region: env.AWS_REGION,
  endpoint: env.SQS_ENDPOINT,
  credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID!, secretAccessKey: env.AWS_SECRET_ACCESS_KEY! },
  maxAttempts: 1,
});

interface Queues {
  names: { input: string; dlq: string; events: string };
  urls: { input: string; dlq: string; events: string };
}

let db: TestDatabase;
let queues: Queues;
/** Processes, gates and queues owned by the current test: they are torn down after it. */
let processes: AppProcess[] = [];
let gates: SqsGate[] = [];
let ownedQueues: Queues[] = [];

async function freshDatabase(): Promise<void> {
  db = await createTestDatabase({ entities: PERSISTENCE_SCHEMAS });
  await db.orm.migrator.up();
}

/** A new database for every test of the block: outbox, inbox and wallets of other tests can never leak in. */
function withFreshDatabasePerTest(): void {
  beforeEach(freshDatabase);
  afterEach(async () => {
    await db.drop();
  });
}

afterEach(async () => {
  await Promise.all(processes.map((proc) => proc.kill('SIGKILL')));
  processes = [];
  await Promise.all(gates.map((gate) => gate.close()));
  gates = [];
  await Promise.all(ownedQueues.map(deleteQueues));
  ownedQueues = [];
});

const deleteQueues = (set: Queues) =>
  Promise.all(Object.values(set.urls).map((url) => sqs.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => undefined)));

async function createQueues(visibilitySeconds: number, options: { shared?: boolean } = {}): Promise<Queues> {
  const id = randomUUID();
  const names = { input: `mp-${id}.fifo`, dlq: `mp-${id}-dlq.fifo`, events: `mp-${id}-events` };
  const dlq = (await sqs.send(new CreateQueueCommand({ QueueName: names.dlq, Attributes: { FifoQueue: 'true' } }))).QueueUrl!;
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }));
  const input = (await sqs.send(new CreateQueueCommand({
    QueueName: names.input,
    Attributes: {
      FifoQueue: 'true',
      VisibilityTimeout: String(visibilitySeconds),
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: Attributes!.QueueArn, maxReceiveCount: '10' }),
    },
  }))).QueueUrl!;
  const events = (await sqs.send(new CreateQueueCommand({ QueueName: names.events }))).QueueUrl!;
  queues = { names, urls: { input, dlq, events } };
  if (!options.shared) ownedQueues.push(queues);
  return queues;
}

const processEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  DATABASE_URL: db.url,
  SQS_ENDPOINT: env.SQS_ENDPOINT!,
  SQS_INPUT_QUEUE_NAME: queues.names.input,
  SQS_DLQ_QUEUE_NAME: queues.names.dlq,
  SQS_EVENTS_QUEUE_NAME: queues.names.events,
  SQS_CONSUMER_WAIT_SECONDS: '1',
  SQS_CONSUMER_RETRY_BASE_SECONDS: '0',
  OUTBOX_POLL_INTERVAL_MS: '50',
  PENDING_REFERENCE_POLL_INTERVAL_MS: '25',
  PENDING_REFERENCE_RETRY_BASE_MS: '100',
  PENDING_REFERENCE_RETRY_MAX_MS: '200',
  PENDING_REFERENCE_MAX_ATTEMPTS: '1000',
  ...extra,
});

async function launch(role: 'api' | 'worker', extra: Record<string, string> = {}): Promise<AppProcess> {
  const proc = await startAppProcess(role, processEnv(extra));
  processes.push(proc);
  return proc;
}
const launchApis = (count: number) => Promise.all(Array.from({ length: count }, () => launch('api')));

async function until<T>(read: () => Promise<T> | T, accept: (value: T) => boolean, what: string, timeoutMs = 40_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await Bun.sleep(25);
  }
}

// ---------- HTTP helpers

const money = (amount: string) => ({ amount, currency: 'BRL' });
type Wallet = { id: string; playerId: string };

async function http(proc: AppProcess, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${proc.url}${path}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function openWallet(api: AppProcess, amount: string): Promise<Wallet> {
  const reply = await http(api, 'POST', '/wallets', { playerId: randomUUID(), initialBalance: money(amount) });
  expect(reply.status).toBe(201);
  return reply.body;
}

function payload(wallet: Wallet, kind: string, overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: money('25.00'),
    ...overrides,
  };
}
const submit = (api: AppProcess, body: any) =>
  http(api, 'POST', '/wagering/transactions', body, { 'Idempotency-Key': `${body.providerId}:${body.externalTransactionId}` });

/** Spreads requests over the processes round-robin, all at once. */
const spread = <T>(apis: AppProcess[], items: T[], send: (api: AppProcess, item: T) => Promise<any>) =>
  Promise.all(items.map((item, index) => send(apis[index % apis.length]!, item)));

// ---------- database and SQS helpers

const balanceOf = async (id: string) => (await db.sql<{ balance: string }>('SELECT balance::text AS balance FROM wallets WHERE id = ?', [id]))[0]!.balance;
const transactionCount = async (walletId: string) =>
  (await db.sql<{ n: number }>(`SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = ? AND kind <> 'OPENING'`, [walletId]))[0]!.n;
const statusCount = async (walletId: string, status: string) =>
  (await db.sql<{ n: number }>(`SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = ? AND status = ?`, [walletId, status]))[0]!.n;

async function inputDepth(): Promise<number> {
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl: queues.urls.input,
    AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
  }));
  return Number(Attributes!.ApproximateNumberOfMessages) + Number(Attributes!.ApproximateNumberOfMessagesNotVisible);
}
const dlqDepth = async () =>
  Number((await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queues.urls.dlq, AttributeNames: ['ApproximateNumberOfMessages'] }))).Attributes!.ApproximateNumberOfMessages);

const sqsData = (wallet: Wallet, kind: string, overrides: Record<string, unknown> = {}) => {
  const { externalTransactionId, ...rest } = payload(wallet, kind, overrides);
  return { ...rest, externalTransactionId, idempotencyKey: `provider-a:${externalTransactionId}` };
};
const envelope = (data: unknown, messageId: string = randomUUID()) => ({
  messageId,
  type: 'WagerTransactionRequested',
  occurredAt: new Date().toISOString(),
  data,
});
/** A fresh deduplication id each time, so redeliveries are caught by the inbox and the idempotency key, not by SQS. */
const sendMessage = (body: unknown, group: string = randomUUID()) =>
  sqs.send(new SendMessageCommand({ QueueUrl: queues.urls.input, MessageBody: JSON.stringify(body), MessageGroupId: group, MessageDeduplicationId: randomUUID() }));

/** Reads the events queue until `count` distinct event ids were seen (or the deadline), removing what it reads. */
async function readEvents(minDistinct: number, timeoutMs = 40_000): Promise<{ distinct: Set<string>; total: number }> {
  const distinct = new Set<string>();
  let total = 0;
  const deadline = Date.now() + timeoutMs;
  while (distinct.size < minDistinct && Date.now() < deadline) {
    const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queues.urls.events, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
    for (const message of Messages) {
      distinct.add(JSON.parse(message.Body!).eventId);
      total += 1;
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queues.urls.events, ReceiptHandle: message.ReceiptHandle! }));
    }
  }
  return { distinct, total };
}

const outboxCounts = async () =>
  (await db.sql<{ total: number; unpublished: number }>(`SELECT count(*)::int AS total, count(*) FILTER (WHERE published_at IS NULL)::int AS unpublished FROM outbox_messages`))[0]!;

// ============================================================================================================

describe('three independent API processes on one database', () => {
  // Shared by the tests of this block, so they are started once and are not tracked by the per-test cleanup.
  let apis: AppProcess[];
  let sharedQueues: Queues;
  beforeAll(async () => {
    await freshDatabase();
    sharedQueues = await createQueues(30, { shared: true });
    apis = await Promise.all(Array.from({ length: 3 }, () => startAppProcess('api', processEnv())));
  }, 120_000);
  afterAll(async () => {
    await Promise.all(apis.map((api) => api.kill('SIGKILL')));
    await deleteQueues(sharedQueues);
    await db.drop();
  });

  test('the same BET sent 50 times in parallel to three processes debits exactly once', async () => {
    for (let round = 0; round < 3; round++) {
      const wallet = await openWallet(apis[0]!, '100.00');
      const bet = payload(wallet, 'BET');
      const replies = await spread(apis, Array.from({ length: 50 }, () => bet), (api, body) => submit(api, body));

      expect(replies.every((reply) => reply.status === 200 || reply.status === 201)).toBe(true);
      expect(replies.filter((reply) => reply.body.idempotentReplay === false)).toHaveLength(1);
      expect(new Set(replies.map((reply) => reply.body.transactionId)).size).toBe(1);
      expect(await balanceOf(wallet.id)).toBe('75.00');
      expect(await movementsOf(db, wallet.id)).toHaveLength(1);
      await assertFinancialInvariants(db, wallet.id);
    }
  }, 120_000);

  test('two BETs of 80.00 over a balance of 100.00: exactly one is processed, the other is rejected, balance 20.00', async () => {
    for (let round = 0; round < 5; round++) {
      const wallet = await openWallet(apis[0]!, '100.00');
      const replies = await spread(apis, [payload(wallet, 'BET', { money: money('80.00') }), payload(wallet, 'BET', { money: money('80.00') })], (api, body) => submit(api, body));

      expect(replies.map((reply) => reply.status).sort()).toEqual([201, 422]);
      expect(replies.find((reply) => reply.status === 422)!.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
      expect(await balanceOf(wallet.id)).toBe('20.00');
      const movements = await movementsOf(db, wallet.id);
      expect(movements).toHaveLength(1);
      expect(movements[0]!.direction).toBe('DEBIT');
      await assertFinancialInvariants(db, wallet.id);
    }
  }, 120_000);

  test('BETs of 100.00, 80.00 and 80.00 racing for 100.00: one wins, the rest are rejected, and the balance matches the winner', async () => {
    const seenWinners = new Set<string>();
    for (let round = 0; round < 8; round++) {
      const wallet = await openWallet(apis[0]!, '100.00');
      const bets = [payload(wallet, 'BET', { money: money('100.00') }), payload(wallet, 'BET', { money: money('80.00') }), payload(wallet, 'BET', { money: money('80.00') })];
      const replies = await spread(apis, bets, (api, body) => submit(api, body));

      const processed = replies.filter((reply) => reply.status === 201);
      const rejected = replies.filter((reply) => reply.status === 422);
      expect([processed.length, rejected.length]).toEqual([1, 2]);
      expect(rejected.every((reply) => reply.body.failureCode === 'INSUFFICIENT_FUNDS')).toBe(true);
      const winner = bets[replies.indexOf(processed[0]!)]!.money.amount;
      seenWinners.add(winner);
      expect(await balanceOf(wallet.id)).toBe(winner === '100.00' ? '0.00' : '20.00');
      expect(await movementsOf(db, wallet.id)).toHaveLength(1);
      await assertFinancialInvariants(db, wallet.id);
    }
    expect([...seenWinners].every((amount) => ['100.00', '80.00'].includes(amount))).toBe(true);
  }, 120_000);

  test('many independent wallets processed in parallel by three processes keep independent, exact ledgers', async () => {
    const wallets = await Promise.all(Array.from({ length: 18 }, (_, i) => openWallet(apis[i % 3]!, '100.00')));
    const requests = wallets.flatMap((wallet) => [
      ...Array.from({ length: 3 }, () => payload(wallet, 'BET', { money: money('10.00') })),
      payload(wallet, 'WIN', { money: money('5.00') }),
      payload(wallet, 'LOSS', { money: money('7.00') }),
    ]);
    const replies = await spread(apis, requests, (api, body) => submit(api, body));
    expect(replies.every((reply) => reply.status === 201)).toBe(true);

    for (const wallet of wallets) {
      expect(await balanceOf(wallet.id)).toBe('75.00');
      expect(await movementsOf(db, wallet.id)).toHaveLength(4);
      await assertFinancialInvariants(db, wallet.id);
    }
  }, 120_000);
});

describe('HTTP and SQS racing for the same wallet across five processes', () => {
  withFreshDatabasePerTest();
  test('three API processes and two workers share one hot wallet: every operation applied once, duplicates ignored', async () => {
    await createQueues(30);
    const apis = await launchApis(3);
    await launch('worker');
    await launch('worker');
    const wallet = await openWallet(apis[0]!, '200.00');

    const httpBets = Array.from({ length: 30 }, () => payload(wallet, 'BET', { money: money('1.00') }));
    const queued = Array.from({ length: 30 }, () => envelope(sqsData(wallet, 'BET', { money: money('1.00') })));
    await Promise.all([
      spread(apis, httpBets, (api, body) => submit(api, body)),
      // Each message is sent three times: only the inbox and the idempotency key may keep it to one debit.
      ...queued.flatMap((message) => [sendMessage(message), sendMessage(message), sendMessage(message)]),
    ]);

    await until(() => transactionCount(wallet.id), (n) => n === 60, 'all 60 distinct operations to be applied');
    await until(inputDepth, (depth) => depth === 0, 'the input queue to drain');
    expect(await balanceOf(wallet.id)).toBe('140.00');
    expect(await movementsOf(db, wallet.id)).toHaveLength(60);
    expect((await db.sql<{ n: number }>('SELECT count(*)::int AS n FROM inbox_messages'))[0]!.n).toBe(30);
    expect(await dlqDepth()).toBe(0);
    await assertFinancialInvariants(db, wallet.id);
  }, 150_000);
});

describe('outbox publishers', () => {
  withFreshDatabasePerTest();
  test('two worker processes publishing the same outbox lose no event', async () => {
    await createQueues(30);
    const api = await launch('api');
    await launch('worker');
    await launch('worker');
    const wallets = await Promise.all(Array.from({ length: 6 }, () => openWallet(api, '100.00')));
    await Promise.all(wallets.flatMap((wallet) => Array.from({ length: 5 }, () => submit(api, payload(wallet, 'BET', { money: money('1.00') })))));

    await until(outboxCounts, (counts) => counts.total >= 66 && counts.unpublished === 0, 'every outbox row to be published');
    const { total } = await outboxCounts();
    const ids = new Set((await db.sql<{ id: string }>('SELECT id FROM outbox_messages')).map((row) => row.id));
    const events = await readEvents(total);

    expect(events.distinct.size).toBe(total);
    expect([...ids].every((id) => events.distinct.has(id))).toBe(true);
    for (const wallet of wallets) await assertFinancialInvariants(db, wallet.id);
  }, 150_000);

  test('a publisher killed while sending leaves its events to another process, which publishes every one', async () => {
    await createQueues(30);
    const gate = await startSqsGate({ host: '127.0.0.1', port: Number(new URL(env.SQS_ENDPOINT!).port) });
    gates.push(gate);
    const api = await launch('api');
    // A short publish timeout makes the lease of a claimed batch short too, so the takeover is quick.
    const doomed = await launch('worker', { SQS_ENDPOINT: `http://127.0.0.1:${gate.port}`, OUTBOX_PUBLISH_TIMEOUT_MS: '400' });

    const stuck = gate.holdNext('SendMessage');
    const wallet = await openWallet(api, '100.00');
    await Promise.all(Array.from({ length: 6 }, () => submit(api, payload(wallet, 'BET', { money: money('1.00') }))));
    await stuck;
    // At this instant the publisher has claimed a batch and is blocked sending: kill it for real.
    await doomed.kill('SIGKILL');
    expect(doomed.isRunning()).toBe(false);
    expect((await outboxCounts()).unpublished).toBeGreaterThanOrEqual(1);

    await launch('worker', { OUTBOX_PUBLISH_TIMEOUT_MS: '400' });
    await until(outboxCounts, (counts) => counts.unpublished === 0, 'the surviving publisher to take over');
    const { total } = await outboxCounts();
    const events = await readEvents(total);
    const ids = (await db.sql<{ id: string }>('SELECT id FROM outbox_messages')).map((row) => row.id);
    expect(ids.every((id) => events.distinct.has(id))).toBe(true);
    await assertFinancialInvariants(db, wallet.id);
  }, 150_000);
});

describe('a worker that dies, or is told to stop, in the middle of a message', () => {
  withFreshDatabasePerTest();
  test('killed after the commit and before the ack: the redelivery is a replay, with no second effect', async () => {
    await createQueues(1);
    const gate = await startSqsGate({ host: '127.0.0.1', port: Number(new URL(env.SQS_ENDPOINT!).port) });
    gates.push(gate);
    const api = await launch('api');
    const doomed = await launch('worker', { SQS_ENDPOINT: `http://127.0.0.1:${gate.port}` });
    const wallet = await openWallet(api, '100.00');
    const messageId = `msg-${randomUUID()}`;

    const ackAttempt = gate.holdNext('DeleteMessage');
    await sendMessage(envelope(sqsData(wallet, 'BET'), messageId));
    await ackAttempt;

    // The worker is about to acknowledge: the transaction must already be committed, and the ack never arrived.
    expect(await balanceOf(wallet.id)).toBe('75.00');
    expect(await movementsOf(db, wallet.id)).toHaveLength(1);
    expect((await db.sql(`SELECT processed_at FROM inbox_messages WHERE message_id = ?`, [messageId]))[0]!.processed_at).not.toBeNull();
    await doomed.kill('SIGKILL');
    expect(doomed.isRunning()).toBe(false);
    expect(await inputDepth()).toBe(1);

    const survivor = await launch('worker');
    await until(inputDepth, (depth) => depth === 0, 'the redelivered message to be acknowledged');
    expect(await balanceOf(wallet.id)).toBe('75.00');
    expect(await movementsOf(db, wallet.id)).toHaveLength(1);
    expect((await db.sql<{ n: number }>('SELECT count(*)::int AS n FROM inbox_messages WHERE message_id = ?', [messageId]))[0]!.n).toBe(1);
    expect(await survivor.sample('wager_duplicates_total{type="inbox_message"}')).toBe(1);
    expect(await dlqDepth()).toBe(0);
    await assertFinancialInvariants(db, wallet.id);
  }, 120_000);

  // Windows has no catchable SIGTERM: the process dies at once, so these two only prove anything on POSIX.
  test.skipIf(process.platform === 'win32')('SIGTERM during a message lets it finish, acknowledges it and exits cleanly', async () => {
    await createQueues(10);
    const api = await launch('api');
    const worker = await launch('worker', { DB_LOCK_TIMEOUT_MS: '20000', SQS_CONSUMER_SHUTDOWN_TIMEOUT_MS: '20000' });
    const wallet = await openWallet(api, '100.00');

    const lock = await holdWalletLock(db, wallet.id);
    await sendMessage(envelope(sqsData(wallet, 'BET')));
    await waitForBlockedSessions(db, 1);

    worker.signal('SIGTERM');
    // It is mid-message, so it must wait for it instead of dying.
    await Bun.sleep(600);
    expect(worker.isRunning()).toBe(true);
    expect(await balanceOf(wallet.id)).toBe('100.00');

    await lock.release();
    // Nest re-raises the signal after a clean shutdown, so the exit code is 143 (128 + SIGTERM); 137 would be a SIGKILL.
    const code = await Promise.race([worker.exited, Bun.sleep(30_000).then(() => 'did not exit')]);
    expect([0, 143]).toContain(code as number);
    expect(await balanceOf(wallet.id)).toBe('75.00');
    expect(await inputDepth()).toBe(0);
    expect(await movementsOf(db, wallet.id)).toHaveLength(1);
    await assertFinancialInvariants(db, wallet.id);
  }, 120_000);

  test.skipIf(process.platform === 'win32')('SIGTERM with a message stuck past the shutdown deadline: it returns to the queue at once, and another process applies it once', async () => {
    // A long visibility timeout proves the message came back because the worker returned it, not because time passed.
    await createQueues(120);
    const api = await launch('api');
    const worker = await launch('worker', { DB_LOCK_TIMEOUT_MS: '4000', SQS_CONSUMER_SHUTDOWN_TIMEOUT_MS: '700' });
    const wallet = await openWallet(api, '100.00');

    const lock = await holdWalletLock(db, wallet.id);
    await sendMessage(envelope(sqsData(wallet, 'BET')));
    await waitForBlockedSessions(db, 1);

    worker.signal('SIGTERM');
    // Bounded by the deadline plus the lock timeout of the transaction that was stuck, never by the visibility timeout.
    expect(await Promise.race([worker.exited.then(() => 'exited'), Bun.sleep(25_000).then(() => 'hung')])).toBe('exited');
    expect(worker.logs.some((line) => line.msg === 'shutdown deadline reached: returning in-flight messages to the queue')).toBe(true);
    await lock.release();
    expect(await balanceOf(wallet.id)).toBe('100.00');

    await launch('worker');
    await until(inputDepth, (depth) => depth === 0, 'the message to be applied by the new worker', 30_000);
    expect(await balanceOf(wallet.id)).toBe('75.00');
    expect(await movementsOf(db, wallet.id)).toHaveLength(1);
    await assertFinancialInvariants(db, wallet.id);
  }, 120_000);
});

describe('restarts', () => {
  withFreshDatabasePerTest();
  test('a worker killed in the middle of a stream of messages: the next one finishes it, with exactly one effect each', async () => {
    await createQueues(1);
    const api = await launch('api');
    const first = await launch('worker');
    const TOTAL = 300;
    const wallet = await openWallet(api, '500.00');

    const messages = Array.from({ length: TOTAL }, () => envelope(sqsData(wallet, 'BET', { money: money('1.00') })));
    const sending = (async () => {
      for (let i = 0; i < messages.length; i += 25) await Promise.all(messages.slice(i, i + 25).map((message) => sendMessage(message)));
    })();

    const doneBeforeKill = await until(() => transactionCount(wallet.id), (n) => n >= 10, 'the first worker to make progress');
    await first.kill('SIGKILL');
    await sending;
    expect(first.isRunning()).toBe(false);
    const atKill = await transactionCount(wallet.id);
    expect(atKill).toBeLessThan(TOTAL);
    expect(atKill).toBeGreaterThanOrEqual(doneBeforeKill);

    await launch('worker');
    await until(() => transactionCount(wallet.id), (n) => n === TOTAL, `all ${TOTAL} messages to be applied`, 90_000);
    await until(inputDepth, (depth) => depth === 0, 'the input queue to drain', 60_000);

    expect(await balanceOf(wallet.id)).toBe('200.00');
    expect(await movementsOf(db, wallet.id)).toHaveLength(TOTAL);
    expect((await db.sql<{ n: number }>('SELECT count(*)::int AS n FROM inbox_messages'))[0]!.n).toBe(TOTAL);
    expect(await dlqDepth()).toBe(0);
    await assertFinancialInvariants(db, wallet.id);
  }, 180_000);

  test('REFUNDs and ROLLBACKs that arrive before their references, across a worker restart, settle exactly once', async () => {
    await createQueues(30);
    const apis = await launchApis(3);
    const first = await launch('worker');
    const wallet = await openWallet(apis[0]!, '200.00');

    const bets = Array.from({ length: 6 }, () => payload(wallet, 'BET', { money: money('25.00') }));
    const wins = Array.from({ length: 3 }, () => payload(wallet, 'WIN', { money: money('10.00') }));
    const refunds = bets.map((bet) => payload(wallet, 'REFUND', { money: money('25.00'), referenceExternalTransactionId: bet.externalTransactionId }));
    const rollbacks = wins.map((win) => payload(wallet, 'ROLLBACK', { money: money('10.00'), referenceExternalTransactionId: win.externalTransactionId }));

    const early = await spread(apis, [...refunds, ...rollbacks], (api, body) => submit(api, body));
    expect(early.every((reply) => reply.status === 202 && reply.body.status === 'PENDING_REFERENCE')).toBe(true);
    // Nothing moved while the references are missing, and the worker has been retrying.
    expect(await balanceOf(wallet.id)).toBe('200.00');
    expect(await movementsOf(db, wallet.id)).toHaveLength(0);
    await until(async () => (await db.sql<{ n: number }>(`SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = ? AND attempts >= 1`, [wallet.id]))[0]!.n, (n) => n === 9, 'every pending reversal to have been retried');

    await first.kill('SIGKILL');
    expect(first.isRunning()).toBe(false);
    await launch('worker');
    await spread(apis, [...bets, ...wins], (api, body) => submit(api, body));

    await until(() => statusCount(wallet.id, 'PENDING_REFERENCE'), (n) => n === 0, 'no reversal left pending', 60_000);
    expect(await statusCount(wallet.id, 'PROCESSED')).toBe(6 + 3 + 6 + 3 + 1);
    expect(await balanceOf(wallet.id)).toBe('200.00');
    const movements = await movementsOf(db, wallet.id);
    expect(movements).toHaveLength(18);
    expect(movements.filter((m) => m.kind === 'REFUND')).toHaveLength(6);
    expect(movements.filter((m) => m.kind === 'ROLLBACK')).toHaveLength(3);
    await assertFinancialInvariants(db, wallet.id);
  }, 180_000);
});
