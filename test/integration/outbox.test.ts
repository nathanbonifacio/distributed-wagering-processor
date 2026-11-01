import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { CreateQueueCommand, DeleteMessageCommand, DeleteQueueCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { MessagePublisher } from '../../src/app/messaging/application/ports/message-publisher.port';
import type { OutboxRepository } from '../../src/app/messaging/application/ports/outbox.repository.port';
import { PublishOutboxBatch } from '../../src/app/messaging/application/publish-outbox-batch.use-case';
import { SqsMessagePublisher } from '../../src/app/messaging/infrastructure/sqs-message-publisher';
import type { WageringPersistence } from '../../src/app/wagering/application/ports/wagering-persistence.port';
import { ProcessWagerTransaction } from '../../src/app/wagering/application/process-wager-transaction.use-case';
import { WagerProcessor } from '../../src/app/wagering/domain/wager-processor';
import { MikroOrmUnitOfWork } from '../../src/database/mikro-orm-unit-of-work';
import { createPersistenceContext, PERSISTENCE_SCHEMAS } from '../../src/persistence.module';
import type { Clock } from '../../src/shared/application/clock.port';
import { systemClock, uuidV7Generator } from '../../src/shared/infrastructure/system-providers';
import { WorkerModule } from '../../src/worker.module';
import { type ApiCluster, startApiCluster } from '../support/api-cluster';
import { testEnv } from '../support/env';
import { assertFinancialInvariants } from '../support/financial-invariants';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

// Pré-requisito: `docker compose up -d postgres localstack`. PostgreSQL e SQS reais: cada teste tem o próprio
// banco e a própria fila. Os testes de "queda" interrompem o fluxo no ponto exato, no mesmo processo; a
// queda de processos reais está em test/concurrency/multiprocess.test.ts.
const LEASE_MS = 30_000;
const TIMEOUT = 30_000;
const env = testEnv();
const sqs = new SQSClient({
  region: env.AWS_REGION,
  endpoint: env.SQS_ENDPOINT,
  credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID!, secretAccessKey: env.AWS_SECRET_ACCESS_KEY! },
  maxAttempts: 1,
});

let db: TestDatabase;
let api: ApiCluster;
let queueName: string;
let queueUrl: string;
const extraQueues: string[] = [];

beforeEach(async () => {
  db = await createTestDatabase({ entities: PERSISTENCE_SCHEMAS });
  await db.orm.migrator.up();
  api = await startApiCluster(db, 1);
  queueName = `outbox-test-${randomUUID()}`;
  queueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: queueName }))).QueueUrl!;
});
afterEach(async () => {
  await api.close();
  await db.drop();
  for (const url of [queueUrl, ...extraQueues.splice(0)]) await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
});

const uow = () => new MikroOrmUnitOfWork<WageringPersistence>(db.orm, createPersistenceContext, 5000);
const realPublisher = (name = queueName, client = sqs) => new SqsMessagePublisher(client, name, 3000);

function batch(
  publisher: MessagePublisher = realPublisher(),
  options: { clock?: Clock; unitOfWork?: MikroOrmUnitOfWork<any>; batchSize?: number } = {},
) {
  return new PublishOutboxBatch(options.unitOfWork ?? uow(), publisher, options.clock ?? systemClock, {
    batchSize: options.batchSize ?? 10,
    leaseMs: LEASE_MS,
  });
}

const later = (ms: number): Clock => ({ now: () => new Date(Date.now() + ms) });

/** Recebe até ter `count` mensagens e confirma que não há mais nenhuma além delas. */
async function receive(count: number, url = queueUrl): Promise<any[]> {
  const bodies: any[] = [];
  const deadline = Date.now() + 15_000;
  let emptyAfterTarget = false;
  while (Date.now() < deadline && !emptyAfterTarget) {
    const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: bodies.length >= count ? 0 : 1 }));
    for (const message of Messages) {
      bodies.push(JSON.parse(message.Body!));
      await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle! }));
    }
    emptyAfterTarget = Messages.length === 0 && bodies.length >= count;
  }
  return bodies;
}

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function openWallet(amount = '100.00') {
  const reply = await api.call('POST', '/wallets', { playerId: randomUUID(), initialBalance: brl(amount) });
  expect(reply.status).toBe(201);
  return reply.body as { id: string; playerId: string };
}

function payload(wallet: { id: string; playerId: string }, kind: string, overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl('25.00'),
    ...overrides,
  };
}

const submit = (body: any) =>
  api.call('POST', '/wagering/transactions', body, { 'Idempotency-Key': `${body.providerId}:${body.externalTransactionId}` });

const rows = () =>
  db.sql<any>('SELECT id, event_type, attempts, published_at, next_attempt_at, last_error FROM outbox_messages ORDER BY occurred_at, id');
const pendingCount = async () => (await db.sql<{ n: number }>('SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL'))[0]!.n;

/** Tipos de evento gravados depois de `before`, em ordem alfabética. */
async function newEventTypes(before: Set<string>) {
  return (await rows()).filter((r: any) => !before.has(r.id)).map((r: any) => r.event_type).sort();
}

describe('events written in the financial transaction', () => {
  test('each operation writes exactly the README events', async () => {
    const P = 'WagerTransactionProcessed';
    const B = 'WalletBalanceChanged';
    const emitted = async (action: () => Promise<{ status: number }>, status: number) => {
      const before = new Set((await rows()).map((r: any) => r.id as string));
      expect((await action()).status).toBe(status);
      return newEventTypes(before);
    };

    let wallet!: { id: string; playerId: string };
    expect(await emitted(async () => {
      const reply = await api.call('POST', '/wallets', { playerId: randomUUID(), initialBalance: brl('100.00') });
      wallet = reply.body;
      return reply;
    }, 201)).toEqual([P, B]); // OPENING

    expect(await emitted(() => api.call('POST', '/wallets', { playerId: randomUUID(), initialBalance: brl('0.00') }), 201)).toEqual([]);

    const bet = payload(wallet, 'BET');
    expect(await emitted(() => submit(bet), 201)).toEqual([P, B]);
    const win = payload(wallet, 'WIN');
    expect(await emitted(() => submit(win), 201)).toEqual([P, B]);
    expect(await emitted(() => submit(payload(wallet, 'LOSS')), 201)).toEqual([P]);
    expect(await emitted(() => submit(payload(wallet, 'REFUND', { referenceExternalTransactionId: bet.externalTransactionId })), 201)).toEqual([P, B]);
    expect(await emitted(() => submit(payload(wallet, 'ROLLBACK', { referenceExternalTransactionId: win.externalTransactionId })), 201)).toEqual([P, B]);
    expect(await emitted(() => submit(payload(wallet, 'BET', { money: brl('9999.00') })), 422)).toEqual(['WagerTransactionRejected']);
    expect(await emitted(() => submit(payload(wallet, 'REFUND', { referenceExternalTransactionId: 'nao-chegou' })), 202)).toEqual(['WagerTransactionPendingReference']);
    expect(await emitted(() => submit(bet), 200)).toEqual([]); // replay
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);

  test('no publication before commit: the publisher sees nothing, and only publishes after the commit', async () => {
    const wallet = await openWallet();
    await batch().execute();
    await receive(2);

    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const atLastEvent = new Promise<void>((resolve) => { reached = resolve; });
    let enqueued = 0;
    const held = new MikroOrmUnitOfWork<WageringPersistence>(db.orm, (em) => {
      const real = createPersistenceContext(em);
      return {
        ...real,
        outbox: Object.assign(Object.create(real.outbox) as OutboxRepository, {
          enqueue: async (record: any) => {
            await real.outbox.enqueue(record);
            if (++enqueued === 2) { reached(); await released; }
          },
        }),
      };
    }, 5000);
    const processing = new ProcessWagerTransaction(held, new WagerProcessor(), systemClock, uuidV7Generator).execute({
      ...(payload(wallet, 'BET') as any),
      idempotencyKey: randomUUID(),
    });
    await atLastEvent;

    expect((await batch().execute()).claimed).toBe(0);
    expect(await receive(0)).toHaveLength(0);

    release();
    await processing;
    expect((await batch().execute()).published).toBe(2);
    expect(await receive(2)).toHaveLength(2);
  }, TIMEOUT);

  test('a rollback leaves no orphan event, and nothing is published', async () => {
    const wallet = await openWallet();
    await batch().execute();
    await receive(2);
    const failing = new MikroOrmUnitOfWork<WageringPersistence>(db.orm, (em) => {
      const real = createPersistenceContext(em);
      return {
        ...real,
        outbox: Object.assign(Object.create(real.outbox) as OutboxRepository, {
          enqueue: async (record: any) => {
            await real.outbox.enqueue(record);
            if (record.eventType === 'WalletBalanceChanged') throw new Error('injected failure');
          },
        }),
      };
    }, 5000);
    const use = new ProcessWagerTransaction(failing, new WagerProcessor(), systemClock, uuidV7Generator);
    let failed = false;
    await use.execute({ ...(payload(wallet, 'BET') as any), idempotencyKey: randomUUID() }).catch(() => { failed = true; });
    expect(failed).toBe(true);

    expect(await rows()).toHaveLength(2); // só os da abertura, já publicados
    expect((await batch().execute()).claimed).toBe(0);
    expect(await receive(0)).toHaveLength(0);
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);
});

describe('publication', () => {
  test('publishes the README envelope to SQS and only then marks it as published', async () => {
    const wallet = await openWallet();
    const before = await rows();
    expect(before.every((r: any) => r.published_at === null)).toBe(true);

    expect(await batch().execute()).toEqual({ claimed: 2, published: 2, failed: 0 });

    const bodies = await receive(2);
    const changed = bodies.find((b) => b.eventType === 'WalletBalanceChanged');
    expect(changed).toMatchObject({
      eventId: before.find((r: any) => r.event_type === 'WalletBalanceChanged').id,
      aggregateId: wallet.id,
      correlationId: expect.any(String),
      occurredAt: expect.any(String),
      version: 1,
      data: { walletId: wallet.id, direction: 'CREDIT', money: brl('100.00'), balanceAfter: brl('100.00'), walletVersion: 1 },
    });
    expect((await rows()).every((r: any) => r.published_at !== null && r.attempts === 0)).toBe(true);
    expect((await batch().execute()).claimed).toBe(0);
    expect(await receive(0)).toHaveLength(0);
  }, TIMEOUT);

  test('the transport refused (queue does not exist): nothing is lost, and the attempt is recorded with backoff', async () => {
    const wallet = await openWallet();
    expect(await batch(realPublisher('fila-que-nao-existe')).execute()).toEqual({ claimed: 2, published: 0, failed: 2 });
    for (const row of await rows()) {
      expect(row.published_at).toBeNull();
      expect(row.attempts).toBe(1);
      expect(row.last_error).toEqual(expect.any(String));
      expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now() - 1000);
    }
    // Ainda dentro do backoff, não há nova tentativa.
    expect((await batch().execute()).claimed).toBe(0);
    await assertFinancialInvariants(db, wallet.id);

    const recovered = await batch(realPublisher(), { clock: later(2000) }).execute();
    expect(recovered).toEqual({ claimed: 2, published: 2, failed: 0 });
    expect(await receive(2)).toHaveLength(2);
    expect(await pendingCount()).toBe(0);
  }, TIMEOUT);

  test('last_error keeps only the error name, without what the message might expose', async () => {
    await openWallet();
    class TransportError extends Error {
      override name = 'TransportError';
    }
    await batch({ publish: async () => { throw new TransportError('http://interno:4566/senha-secreta'); } }).execute();
    for (const row of await rows()) expect(row.last_error).toBe('TransportError');
  }, TIMEOUT);

  test('SQS unreachable: the API keeps confirming transactions, without losing events, and the balance does not change', async () => {
    const wallet = await openWallet();
    const down = new SQSClient({ region: env.AWS_REGION, endpoint: 'http://127.0.0.1:1', credentials: { accessKeyId: 'x', secretAccessKey: 'x' }, maxAttempts: 1 });

    expect((await batch(realPublisher(queueName, down)).execute()).published).toBe(0);
    const bet = await submit(payload(wallet, 'BET'));
    expect(bet.status).toBe(201);
    expect((await batch(realPublisher(queueName, down), { clock: later(2000) }).execute()).published).toBe(0);
    await assertFinancialInvariants(db, wallet.id);
    expect((await db.sql<{ balance: string }>('SELECT balance::text AS balance FROM wallets WHERE id = ?', [wallet.id]))[0]!.balance).toBe('75.00');
    expect(await rows()).toHaveLength(4);
    expect(await pendingCount()).toBe(4);

    const recovered = await batch(realPublisher(), { clock: later(10_000) }).execute();
    expect(recovered.published).toBe(4);
    expect(new Set((await receive(4)).map((b) => b.eventId)).size).toBe(4);
  }, TIMEOUT);

  test('FIFO queue: group per aggregate and deduplication by eventId', async () => {
    const name = `outbox-test-${randomUUID()}.fifo`;
    const url = (await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: 'true' } }))).QueueUrl!;
    extraQueues.push(url);
    await openWallet();
    expect((await batch(realPublisher(name)).execute()).published).toBe(2);

    const messages: any[] = [];
    const deadline = Date.now() + 10_000;
    while (messages.length < 2 && Date.now() < deadline) {
      const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageSystemAttributeNames: ['MessageGroupId', 'MessageDeduplicationId'] }));
      for (const message of Messages) {
        messages.push(message);
        await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle! }));
      }
    }
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      const body = JSON.parse(message.Body);
      expect(message.Attributes.MessageGroupId).toBe(body.aggregateId);
      expect(message.Attributes.MessageDeduplicationId).toBe(body.eventId);
    }
  }, TIMEOUT);
});

describe('recovery after a crash', () => {
  test('crashed before publishing: the reservation prevents an immediate repeat and, once it expires, another instance publishes', async () => {
    await openWallet();
    const now = new Date();
    const claimed = await uow().run((c) => c.outbox.claimDue(now, 10, new Date(now.getTime() + LEASE_MS)));
    expect(claimed).toHaveLength(2);
    // O processo morre aqui, sem publicar.

    expect((await batch().execute()).claimed).toBe(0);
    expect(await receive(0)).toHaveLength(0);

    const recovered = await batch(realPublisher(), { clock: later(LEASE_MS + 1000) }).execute();
    expect(recovered.published).toBe(2);
    expect((await receive(2)).map((b) => b.eventId).sort()).toEqual(claimed.map((m) => m.id).sort());
  }, TIMEOUT);

  test('crashed between SQS and PostgreSQL: publishes again, with the same eventId', async () => {
    await openWallet();
    // A confirmação no banco falha depois de o SQS já ter aceitado: é o que a queda faria.
    const crashing = new MikroOrmUnitOfWork<{ outbox: OutboxRepository }>(db.orm, (em) => {
      const real = createPersistenceContext(em);
      return { outbox: Object.assign(Object.create(real.outbox) as OutboxRepository, { save: async () => { throw new Error('queda'); } }) };
    }, 5000);
    let crashed = false;
    await batch(realPublisher(), { unitOfWork: crashing }).execute().catch(() => { crashed = true; });
    expect(crashed).toBe(true);
    const first = await receive(2);
    expect(await pendingCount()).toBe(2);

    expect((await batch().execute()).claimed).toBe(0); // ainda reservado
    const retried = await batch(realPublisher(), { clock: later(LEASE_MS + 1000) }).execute();
    expect(retried.published).toBe(2);

    const second = await receive(2);
    expect(second.map((b) => b.eventId).sort()).toEqual(first.map((b) => b.eventId).sort());
    expect(second.map((b) => JSON.stringify(b)).sort()).toEqual(first.map((b) => JSON.stringify(b)).sort());
    expect(await pendingCount()).toBe(0);
  }, TIMEOUT);

  test('a late attempt that failed does not reopen the event already published by another', async () => {
    await openWallet();
    const now = new Date();
    const stale = await uow().run((c) => c.outbox.claimDue(now, 10, new Date(now.getTime() + 1)));
    await batch(realPublisher(), { clock: later(1000) }).execute();
    expect(await pendingCount()).toBe(0);

    for (const message of stale) message.scheduleRetry(new Date(), 'Atrasado');
    await uow().run(async (c) => { for (const message of stale) await c.outbox.save(message); });
    expect(await pendingCount()).toBe(0);
    expect((await batch(realPublisher(), { clock: later(60_000) }).execute()).claimed).toBe(0);
  }, TIMEOUT);

  test('real worker: publishes the pending ones on startup, and the new ones while it runs; shuts down normally', async () => {
    const wallet = await openWallet();
    await submit(payload(wallet, 'BET'));
    const start = async (): Promise<INestApplicationContext> => {
      const app = await NestFactory.createApplicationContext(
        WorkerModule.register(testEnv({ DATABASE_URL: db.url, SQS_EVENTS_QUEUE_NAME: queueName, OUTBOX_POLL_INTERVAL_MS: '50' })),
        { logger: false },
      );
      await app.init();
      return app;
    };

    const worker = await start();
    try {
      expect(new Set((await receive(4)).map((b) => b.eventId)).size).toBe(4);
      await submit(payload(wallet, 'LOSS'));
      const [event] = await receive(1);
      expect(event.eventType).toBe('WagerTransactionProcessed');
      expect(event.data.kind).toBe('LOSS');
    } finally {
      await worker.close();
    }

    // Parado, nada é publicado; ao reiniciar, publica o que ficou pendente.
    await submit(payload(wallet, 'LOSS'));
    expect(await pendingCount()).toBe(1);
    const restarted = await start();
    try {
      expect(await receive(1)).toHaveLength(1);
    } finally {
      await restarted.close();
    }
    expect(await pendingCount()).toBe(0);
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);
});

describe('concurrent publishers', () => {
  /** Publisher real que registra quem publicou o quê. */
  const recording = (seen: string[]): MessagePublisher => {
    const real = realPublisher();
    return { publish: async (message) => { await real.publish(message); seen.push(message.id); } };
  };

  test('three publishers, each with its own connection: every event, without repetition', async () => {
    for (let i = 0; i < 12; i++) await openWallet();
    const total = (await rows()).length;
    const seen: string[][] = [[], [], []];
    const clusters = await Promise.all(seen.map(() => createTestDatabaseFork()));

    const drain = async (publisherIndex: number) => {
      const publisher = batch(recording(seen[publisherIndex]!), { unitOfWork: clusters[publisherIndex]!.unitOfWork, batchSize: 3 });
      while ((await publisher.execute()).claimed > 0);
    };
    await Promise.all(seen.map((_, index) => drain(index)));
    await Promise.all(clusters.map((cluster) => cluster.close()));

    const published = seen.flat();
    expect(published).toHaveLength(total);
    expect(new Set(published).size).toBe(total);
    expect(seen.filter((ids) => ids.length > 0).length).toBeGreaterThan(1);
    expect(await pendingCount()).toBe(0);
    const bodies = await receive(total);
    expect(bodies).toHaveLength(total);
    expect(new Set(bodies.map((b) => b.eventId)).size).toBe(total);
  }, TIMEOUT);

  async function createTestDatabaseFork() {
    const { MikroORM } = await import('@mikro-orm/postgresql');
    const orm = new MikroORM({ clientUrl: db.url, entities: PERSISTENCE_SCHEMAS, discovery: { warnWhenNoEntities: false }, allowGlobalContext: false });
    return { unitOfWork: new MikroOrmUnitOfWork<WageringPersistence>(orm, createPersistenceContext, 5000), close: () => orm.close(true) };
  }

  test('SKIP LOCKED: rows locked by another publisher are skipped at once, without waiting', async () => {
    await openWallet();
    await openWallet();
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked!: (ids: string[]) => void;
    const lockedIds = new Promise<string[]>((resolve) => { locked = resolve; });
    const now = new Date();
    const other = uow().run(async (c) => {
      const claimed = await c.outbox.claimDue(now, 2, new Date(now.getTime() + LEASE_MS));
      locked(claimed.map((m) => m.id));
      await released; // transação aberta: as linhas seguem travadas
    });
    const held = await lockedIds;

    const startedAt = Date.now();
    const taken = await uow().run((c) => c.outbox.claimDue(new Date(), 10, new Date(Date.now() + LEASE_MS)));
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(taken).toHaveLength(2);
    expect(taken.some((m) => held.includes(m.id))).toBe(false);

    release();
    await other;
  }, TIMEOUT);

  test('events of different wallets do not block each other, and the financial operation does not wait for the publisher', async () => {
    const wallet = await openWallet();
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let publishing!: () => void;
    const inFlight = new Promise<void>((resolve) => { publishing = resolve; });
    const slow = batch({ publish: async () => { publishing(); await released; } });
    const running = slow.execute();
    await inFlight;

    // Com a publicação presa na rede, nenhuma linha fica travada e o dinheiro continua andando.
    expect((await submit(payload(wallet, 'BET'))).status).toBe(201);
    const idle = await db.sql<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'`);
    expect(idle[0]!.n).toBe(0);

    release();
    expect((await running).published).toBe(2);
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);
});
