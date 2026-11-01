import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CreateQueueCommand, DeleteMessageCommand, DeleteQueueCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { MessagePublisher } from '../../src/app/messaging/application/ports/message-publisher.port';
import { PublishOutboxBatch } from '../../src/app/messaging/application/publish-outbox-batch.use-case';
import { SqsMessagePublisher } from '../../src/app/messaging/infrastructure/sqs-message-publisher';
import type { WageringPersistence } from '../../src/app/wagering/application/ports/wagering-persistence.port';
import { MikroOrmUnitOfWork } from '../../src/database/mikro-orm-unit-of-work';
import { createPersistenceContext, PERSISTENCE_SCHEMAS } from '../../src/persistence.module';
import { testEnv } from '../support/env';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

// Real PostgreSQL. A publisher whose lease expired finishes after another one took the same row over.
const LEASE_MS = 30_000;
const T0 = new Date('2026-11-01T12:00:00.000Z');
const AFTER_LEASE = new Date(T0.getTime() + LEASE_MS + 1000);
const LEASE_B = new Date(AFTER_LEASE.getTime() + LEASE_MS);
const WELL_AFTER = new Date(T0.getTime() + 3_600_000);

let db: TestDatabase;

beforeEach(async () => {
  db = await createTestDatabase({ entities: PERSISTENCE_SCHEMAS });
  await db.orm.migrator.up();
});
afterEach(async () => {
  await db.drop();
});

const uow = (orm: MikroORM = db.orm) => new MikroOrmUnitOfWork<WageringPersistence>(orm, createPersistenceContext, 5000);

function publisherAt(clock: { at: Date }, publisher: MessagePublisher, orm?: MikroORM) {
  return new PublishOutboxBatch(uow(orm), publisher, { now: () => clock.at }, { batchSize: 50, leaseMs: LEASE_MS });
}

async function seedEvent(): Promise<string> {
  const id = randomUUID();
  await uow().run((c) =>
    c.outbox.enqueue({ id, aggregateId: randomUUID(), eventType: 'WalletBalanceChanged', payload: { eventId: id }, occurredAt: T0, nextAttemptAt: T0 }),
  );
  return id;
}

const row = async (id: string) =>
  (await db.sql<{ attempts: number; next_attempt_at: string; published_at: string | null; last_error: string | null }>(
    'SELECT attempts, next_attempt_at, published_at, last_error FROM outbox_messages WHERE id = ?',
    [id],
  ))[0]!;
const scheduledAt = async (id: string) => new Date((await row(id)).next_attempt_at).getTime();

const fails: MessagePublisher = { publish: async () => { throw new Error('injected'); } };
const succeeds: MessagePublisher = { publish: async () => {} };

/** Starts a batch that claims at `at` and stays inside the publisher until `finish` is called with the result. */
async function inFlight(at: Date, orm?: MikroORM, send?: MessagePublisher) {
  let finish!: (fail: boolean) => void;
  const decided = new Promise<boolean>((resolve) => { finish = resolve; });
  let entered!: () => void;
  const publishing = new Promise<void>((resolve) => { entered = resolve; });
  const clock = { at };
  const result = publisherAt(clock, {
    publish: async (message) => {
      await send?.publish(message);
      entered();
      if (await decided) throw new Error('injected');
    },
  }, orm).execute();
  await publishing;
  return {
    clock,
    finishAt: async (when: Date, fail: boolean) => {
      clock.at = when;
      finish(fail);
      return result;
    },
  };
}

/** A holds an expired lease and B has just taken the row over, still publishing. */
async function overlapping() {
  const a = await inFlight(T0);
  const b = await inFlight(AFTER_LEASE);
  expect(new Date((await row(eventId)).next_attempt_at)).toEqual(LEASE_B);
  return { a, b };
}

let eventId: string;

describe('outbox lease: late results', () => {
  beforeEach(async () => {
    eventId = await seedEvent();
  });

  test('a late failure does not touch the lease another publisher holds, and still counts', async () => {
    const { a, b } = await overlapping();
    await a.finishAt(new Date(AFTER_LEASE.getTime() + 100), true);

    expect(await scheduledAt(eventId)).toBe(LEASE_B.getTime());
    expect((await row(eventId)).attempts).toBe(1);
    await b.finishAt(new Date(AFTER_LEASE.getTime() + 200), false);
  });

  test('a late failure does not make the row claimable while the current holder is publishing', async () => {
    const { a, b } = await overlapping();
    await a.finishAt(new Date(AFTER_LEASE.getTime() + 100), true);

    const insideLeaseB = new Date(AFTER_LEASE.getTime() + 5000);
    expect((await publisherAt({ at: insideLeaseB }, succeeds).execute()).claimed).toBe(0);
    await b.finishAt(insideLeaseB, false);
  });

  test('both failures count, late one first: the backoff of the current holder uses the stored total', async () => {
    const { a, b } = await overlapping();
    await a.finishAt(new Date(AFTER_LEASE.getTime() + 100), true);
    const failedAt = new Date(AFTER_LEASE.getTime() + 200);
    await b.finishAt(failedAt, true);

    const after = await row(eventId);
    expect(after.attempts).toBe(2);
    expect(await scheduledAt(eventId)).toBe(failedAt.getTime() + 2000);
    expect(after.published_at).toBeNull();
  });

  test('both failures count, late one last: it does not replace the retry already scheduled', async () => {
    const { a, b } = await overlapping();
    const failedAt = new Date(AFTER_LEASE.getTime() + 100);
    await b.finishAt(failedAt, true);
    await a.finishAt(new Date(AFTER_LEASE.getTime() + 200), true);

    expect((await row(eventId)).attempts).toBe(2);
    expect(await scheduledAt(eventId)).toBe(failedAt.getTime() + 1000);
  });

  test('a late success is recorded, and the failure of the current holder does not reopen it', async () => {
    const { a, b } = await overlapping();
    const publishedAt = new Date(AFTER_LEASE.getTime() + 100);
    await a.finishAt(publishedAt, false);
    await b.finishAt(new Date(AFTER_LEASE.getTime() + 200), true);

    const after = await row(eventId);
    expect(new Date(after.published_at!)).toEqual(publishedAt);
    expect(after.attempts).toBe(0);
    expect((await publisherAt({ at: WELL_AFTER }, succeeds).execute()).claimed).toBe(0);
  });

  test('a late failure does not reopen what the current holder published', async () => {
    const { a, b } = await overlapping();
    const publishedAt = new Date(AFTER_LEASE.getTime() + 100);
    await b.finishAt(publishedAt, false);
    await a.finishAt(new Date(AFTER_LEASE.getTime() + 200), true);

    const after = await row(eventId);
    expect(new Date(after.published_at!)).toEqual(publishedAt);
    expect(after.attempts).toBe(0);
    expect((await publisherAt({ at: WELL_AFTER }, succeeds).execute()).claimed).toBe(0);
  });

  test('two successes keep the first publication date', async () => {
    const { a, b } = await overlapping();
    const first = new Date(AFTER_LEASE.getTime() + 100);
    await b.finishAt(first, false);
    await a.finishAt(new Date(AFTER_LEASE.getTime() + 200), false);

    expect(new Date((await row(eventId)).published_at!)).toEqual(first);
  });

  test('no event is lost: after a late failure the current holder dies, and the row comes back when its lease ends', async () => {
    const { a } = await overlapping(); // B never finishes: it stands for a dead process
    await a.finishAt(new Date(AFTER_LEASE.getTime() + 100), true);

    expect((await publisherAt({ at: new Date(LEASE_B.getTime() - 1) }, succeeds).execute()).claimed).toBe(0);
    const recovered = await publisherAt({ at: LEASE_B }, succeeds).execute();
    expect(recovered.published).toBe(1);
    expect((await row(eventId)).published_at).not.toBeNull();
  });
});

describe('outbox lease: restart and real SQS', () => {
  const env = testEnv();
  const sqs = new SQSClient({
    region: env.AWS_REGION,
    endpoint: env.SQS_ENDPOINT,
    credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID!, secretAccessKey: env.AWS_SECRET_ACCESS_KEY! },
    maxAttempts: 1,
  });

  test('a new instance takes over from a slow one: delivered twice with the same eventId, and settled once', async () => {
    eventId = await seedEvent();
    const queueName = `outbox-lease-${randomUUID()}`;
    const queueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: queueName }))).QueueUrl!;
    const sender = new SqsMessagePublisher(sqs, queueName, 3000);
    const restarted = new MikroORM({ clientUrl: db.url, entities: PERSISTENCE_SCHEMAS, allowGlobalContext: false });
    try {
      const slow = await inFlight(T0, db.orm, sender);
      const publishedAt = new Date(AFTER_LEASE.getTime() + 100);
      const clock = { at: AFTER_LEASE };
      const takeover = publisherAt(clock, { publish: async (message) => { await sender.publish(message); clock.at = publishedAt; } }, restarted);
      expect((await takeover.execute()).published).toBe(1);
      await slow.finishAt(new Date(AFTER_LEASE.getTime() + 200), true);

      const bodies: any[] = [];
      const deadline = Date.now() + 15_000;
      while (bodies.length < 2 && Date.now() < deadline) {
        const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
        for (const message of Messages) {
          bodies.push(JSON.parse(message.Body!));
          await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle! }));
        }
      }
      expect(bodies.map((body) => body.eventId)).toEqual([eventId, eventId]);
      expect(new Date((await row(eventId)).published_at!)).toEqual(publishedAt);
    } finally {
      await restarted.close(true);
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    }
  }, 30_000);

  test('after a reservation that never finished, a restarted instance publishes and the counters stay at zero', async () => {
    eventId = await seedEvent();
    await inFlight(T0); // dies here
    const restarted = new MikroORM({ clientUrl: db.url, entities: PERSISTENCE_SCHEMAS, allowGlobalContext: false });
    try {
      expect((await publisherAt({ at: AFTER_LEASE }, succeeds, restarted).execute()).published).toBe(1);
    } finally {
      await restarted.close(true);
    }
    const after = await row(eventId);
    expect(after.attempts).toBe(0);
    expect(after.published_at).not.toBeNull();
  });
});

describe('outbox lease: independent processes', () => {
  test('three processes failing over overlapping leases: no failure is lost, no deadlock, nothing published', async () => {
    const events = 20;
    for (let i = 0; i < events; i++) await seedEvent();
    const script = fileURLToPath(new URL('../support/outbox-failing-publisher.process.ts', import.meta.url));

    const processes = Array.from({ length: 3 }, () =>
      Bun.spawn([process.execPath, 'run', script, db.url, '15'], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' }),
    );
    const outputs = await Promise.all(
      processes.map(async (proc) => {
        const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        expect({ code, stderr: code === 0 ? '' : stderr }).toEqual({ code: 0, stderr: '' });
        return JSON.parse(stdout.trim().split('\n').at(-1)!) as { failed: number };
      }),
    );

    const reported = outputs.reduce((sum, output) => sum + output.failed, 0);
    const [stored] = await db.sql<{ attempts: number; published: number; n: number }>(
      'SELECT sum(attempts)::int AS attempts, count(published_at)::int AS published, count(*)::int AS n FROM outbox_messages',
    );
    expect(reported).toBeGreaterThan(events);
    expect(stored).toEqual({ attempts: reported, published: 0, n: events });
  }, 90_000);
});

describe('outbox lease: the public save() path and the lease token', () => {
  beforeEach(async () => {
    eventId = await seedEvent();
  });

  const claim = (now: Date, leaseUntil: Date) => uow().run((c) => c.outbox.claimDue(now, 10, leaseUntil));

  test('save() of a copy from a replaced reservation changes nothing, even outside the locked flow', async () => {
    const [stale] = await claim(T0, new Date(T0.getTime() + LEASE_MS));
    const [current] = await claim(AFTER_LEASE, LEASE_B);
    expect(current!.nextAttemptAt).toEqual(LEASE_B);

    stale!.scheduleRetry(new Date(AFTER_LEASE.getTime() + 100), 'StaleError');
    const applied = await uow().run((c) => c.outbox.save(stale!));

    expect(applied).toBe(false);
    const after = await row(eventId);
    expect(new Date(after.next_attempt_at)).toEqual(LEASE_B);
    expect(after.attempts).toBe(0);
    expect(after.last_error).toBeNull();
  });

  test('save() of the copy that still holds the reservation is applied', async () => {
    const [current] = await claim(T0, new Date(T0.getTime() + LEASE_MS));
    current!.scheduleRetry(new Date(T0.getTime() + 100), 'TimeoutError');
    expect(await uow().run((c) => c.outbox.save(current!))).toBe(true);

    const after = await row(eventId);
    expect(after.attempts).toBe(1);
    expect(new Date(after.next_attempt_at)).toEqual(new Date(T0.getTime() + 100 + 1000));
  });

  test('tokens of successive reservations strictly increase, also at the exact boundary of the previous lease', async () => {
    const [a] = await claim(T0, new Date(T0.getTime() + LEASE_MS));
    const boundary = a!.nextAttemptAt; // due exactly when the lease ends: comparison is <=
    const [b] = await claim(boundary, new Date(boundary.getTime() + LEASE_MS));
    const [c] = await claim(b!.nextAttemptAt, new Date(b!.nextAttemptAt.getTime() + LEASE_MS));

    expect(b).toBeDefined();
    expect(c).toBeDefined();
    const tokens = [a!, b!, c!].map((message) => message.nextAttemptAt.getTime());
    expect(tokens[1]).toBeGreaterThan(tokens[0]!);
    expect(tokens[2]).toBeGreaterThan(tokens[1]!);
    expect(await scheduledAt(eventId)).toBe(tokens[2]!);
  });

  test('a publisher whose clock is an hour behind can take over early, but its token still differs from the holder it replaced', async () => {
    const realNow = new Date(T0.getTime() + 2 * 3_600_000);
    const slowNow = new Date(realNow.getTime() - 3_600_000); // still after T0, so the row is due for it too
    const [slowClock] = await claim(slowNow, new Date(slowNow.getTime() + LEASE_MS));
    expect(slowClock).toBeDefined();
    // The accurate clock sees that lease as long expired and takes over immediately: duplicates, never corruption.
    const [accurate] = await claim(realNow, new Date(realNow.getTime() + LEASE_MS));
    expect(accurate).toBeDefined();
    expect(accurate!.nextAttemptAt.getTime()).not.toBe(slowClock!.nextAttemptAt.getTime());

    slowClock!.scheduleRetry(realNow, 'LateError');
    expect(await uow().run((c) => c.outbox.save(slowClock!))).toBe(false);
    expect(await scheduledAt(eventId)).toBe(accurate!.nextAttemptAt.getTime());
  });

  test('a zero-length lease would make two reservations share one token, so the use case refuses it', async () => {
    const [first] = await claim(T0, T0);
    const [second] = await claim(T0, T0);
    expect(second!.nextAttemptAt.getTime()).toBe(first!.nextAttemptAt.getTime());

    for (const leaseMs of [0, -1, 1.5, Number.NaN]) {
      expect(() => new PublishOutboxBatch(uow(), succeeds, { now: () => T0 }, { batchSize: 1, leaseMs })).toThrow();
    }
  });
});
