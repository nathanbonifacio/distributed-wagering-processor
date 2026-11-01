import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { type INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { WageringPersistence } from '../../src/app/wagering/application/ports/wagering-persistence.port';
import {
  type ProcessWagerCommand,
  ProcessWagerTransaction,
} from '../../src/app/wagering/application/process-wager-transaction.use-case';
import { RetryPendingReferences } from '../../src/app/wagering/application/retry-pending-references.use-case';
import { FailureCode } from '../../src/app/wagering/domain/failure-code';
import { ReferenceRetryPolicy } from '../../src/app/wagering/domain/reference-retry-policy';
import { WagerProcessor } from '../../src/app/wagering/domain/wager-processor';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/app/wagering/domain/wager-transaction.entity';
import { PendingReferenceRetrierModule } from '../../src/app/wagering/infrastructure/pending-reference-retrier.module';
import { WageringModule } from '../../src/app/wagering/wagering.module';
import { Wallet } from '../../src/app/wallet/domain/wallet.entity';
import { MikroOrmUnitOfWork } from '../../src/database/mikro-orm-unit-of-work';
import { createPersistenceContext, PERSISTENCE_SCHEMAS, PersistenceModule } from '../../src/persistence.module';
import type { Clock } from '../../src/shared/application/clock.port';
import {
  PermanentInfrastructureError,
  TransientInfrastructureError,
} from '../../src/shared/application/infrastructure-error';
import type { UnitOfWork } from '../../src/shared/application/unit-of-work.port';
import { Money } from '../../src/shared/domain/money';
import { ConfigModule } from '../../src/shared/infrastructure/config.module';
import { uuidV7Generator } from '../../src/shared/infrastructure/system-providers';
import { holdWalletLock, waitForBlockedSessions } from '../support/api-cluster';
import { testEnv } from '../support/env';
import { assertFinancialInvariants, movementsOf } from '../support/financial-invariants';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

// Prerequisite: `docker compose up -d postgres`. Real PostgreSQL, disposable database, no database mocks.
// Time is a controlled clock, so backoff and due dates are asserted exactly instead of slept through.
const PROVIDER = 'provider-a';
const ROUND = 'round-1';
const T_START = new Date('2026-11-01T10:00:00.000Z');
const POLICY = ReferenceRetryPolicy.from({ baseDelayMs: 1000, maxDelayMs: 4000, maxAttempts: 4 });
const BATCH = 10;

class ManualClock implements Clock {
  constructor(private current = new Date(T_START)) {}
  now(): Date {
    return new Date(this.current);
  }
  set(at: Date): void {
    this.current = new Date(at);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

let db: TestDatabase;
let uow: UnitOfWork<WageringPersistence>;
let clock: ManualClock;
let useCase: ProcessWagerTransaction;
let retrier: RetryPendingReferences;

const buildUseCase = (unitOfWork: UnitOfWork<WageringPersistence>, withClock: Clock = clock) =>
  new ProcessWagerTransaction(unitOfWork, new WagerProcessor(), withClock, uuidV7Generator, POLICY);
const buildRetrier = (unitOfWork: UnitOfWork<WageringPersistence>, processWager: ProcessWagerTransaction, withClock: Clock = clock) =>
  new RetryPendingReferences(unitOfWork, processWager, withClock, BATCH);

/** Real unit of work in which chosen repositories run the real SQL and then fail on purpose. */
const uowWith = (override: (real: WageringPersistence) => Partial<WageringPersistence>) =>
  new MikroOrmUnitOfWork<WageringPersistence>(
    db.orm,
    (em) => {
      const real = createPersistenceContext(em);
      return { ...real, ...override(real) };
    },
    5000,
  );

const overriding = <T extends object>(real: T, methods: Partial<T>): T => Object.assign(Object.create(real), methods);

beforeAll(async () => {
  db = await createTestDatabase({ entities: PERSISTENCE_SCHEMAS });
  await db.orm.migrator.up();
  uow = new MikroOrmUnitOfWork(db.orm, createPersistenceContext, 5000);
});
afterAll(async () => {
  await db.drop();
});

// Every test starts at the same instant and with fresh use cases, and opens its own wallets. Pending rows
// left by earlier tests are parked far in the future, so a retrier only ever claims this test's rows.
async function resetClock(): Promise<void> {
  await db.sql(`UPDATE wager_transactions SET next_attempt_at = '2999-01-01T00:00:00Z' WHERE status = 'PENDING_REFERENCE'`);
  clock = new ManualClock();
  useCase = buildUseCase(uow);
  retrier = buildRetrier(uow, useCase);
}

async function openWallet(amount = '100.00'): Promise<Wallet> {
  const money = Money.from({ amount, currency: 'BRL' });
  const at = clock.now();
  const wallet = Wallet.open({ id: randomUUID(), playerId: randomUUID(), initialBalance: money, at });
  const opening = WagerTransaction.createOpening({
    id: randomUUID(),
    payloadHash: 'b'.repeat(64),
    walletId: wallet.id,
    playerId: wallet.playerId,
    money,
    createdAt: at,
  });
  const { ledgerEntry } = new WagerProcessor().processOpening({ wallet, transaction: opening, ledgerEntryId: randomUUID(), at });
  await uow.run(async (c) => {
    await c.wallets.insert(wallet);
    await c.transactions.insertIfAbsent(opening);
    await c.ledger.append(ledgerEntry!);
  });
  return wallet;
}

function command(wallet: Wallet, kind: Kind, overrides: Partial<ProcessWagerCommand> = {}): ProcessWagerCommand {
  const externalTransactionId = overrides.externalTransactionId ?? randomUUID();
  return {
    providerId: PROVIDER,
    externalTransactionId,
    idempotencyKey: `${PROVIDER}:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: ROUND,
    gameId: 'fortune-chimp',
    kind,
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

const refundOf = (wallet: Wallet, bet: ProcessWagerCommand, overrides: Partial<ProcessWagerCommand> = {}) =>
  command(wallet, Kind.Refund, { referenceExternalTransactionId: bet.externalTransactionId, ...overrides });

const readTx = async (id: string) => (await uow.run((c) => c.transactions.findById(id)))!;
const readWallet = async (id: string) => (await uow.run((c) => c.wallets.findById(id)))!;
const balanceOf = async (id: string) => (await readWallet(id)).balance.toJSON().amount;

async function eventTypesFor(walletId: string): Promise<string[]> {
  const rows = await db.sql(`SELECT event_type FROM outbox_messages WHERE payload->'data'->>'walletId' = ? ORDER BY occurred_at, event_type`, [walletId]);
  return rows.map((row) => row.event_type as string).sort();
}

const eventCount = async (walletId: string, type: string) => (await eventTypesFor(walletId)).filter((t) => t === type).length;

/** Due now: moves the clock to the transaction's own next attempt. */
async function advanceToDue(transactionId: string): Promise<void> {
  const tx = await readTx(transactionId);
  expect(tx.nextAttemptAt).toBeDefined();
  clock.set(tx.nextAttemptAt!);
}

describe('reversal that arrives before its reference', () => {
  test('REFUND before BET: pending with no financial effect, then settled once when the BET arrives', async () => {
    await resetClock();
    const wallet = await openWallet('100.00');
    const bet = command(wallet, Kind.Bet);
    const refund = refundOf(wallet, bet);

    const pending = await useCase.execute(refund);
    expect(pending).toMatchObject({ status: Status.PendingReference, idempotentReplay: false });
    expect(pending.balance).toBeUndefined();
    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect(await movementsOf(db, wallet.id)).toHaveLength(0);
    expect(await eventTypesFor(wallet.id)).toEqual(['WagerTransactionPendingReference']);
    const stored = await readTx(pending.transactionId);
    expect(stored.attempts).toBe(0);
    expect(stored.nextAttemptAt).toEqual(new Date(T_START.getTime() + 1000));

    // The reference arrives, but the retry is not due yet: nothing may happen.
    await useCase.execute(bet);
    expect(await retrier.execute()).toMatchObject({ claimed: 0, failed: 0 });
    expect((await readTx(pending.transactionId)).status).toBe(Status.PendingReference);
    expect(await balanceOf(wallet.id)).toBe('75.00');

    await advanceToDue(pending.transactionId);
    expect(await retrier.execute()).toMatchObject({ claimed: 1, failed: 0 });

    const settled = await readTx(pending.transactionId);
    const betTx = await uow.run((c) => c.transactions.findByExternalId(PROVIDER, bet.externalTransactionId));
    expect(settled.status).toBe(Status.Processed);
    expect(settled.referenceTransactionId).toBe(betTx!.id);
    expect(settled.observedBalance?.toJSON().amount).toBe('100.00');
    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect((await movementsOf(db, wallet.id)).map((m) => m.direction)).toEqual(['DEBIT', 'CREDIT']);
    expect(await eventTypesFor(wallet.id)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WalletBalanceChanged',
    ]);
    await assertFinancialInvariants(db, wallet.id);

    // Nothing is left to do, and running again changes nothing.
    expect(await retrier.execute()).toMatchObject({ claimed: 0 });
    expect(await movementsOf(db, wallet.id)).toHaveLength(2);
  });

  test('ROLLBACK before its WIN: the rollback debits the win only after the win exists', async () => {
    await resetClock();
    const wallet = await openWallet('100.00');
    const win = command(wallet, Kind.Win);
    const rollback = command(wallet, Kind.Rollback, { referenceExternalTransactionId: win.externalTransactionId });

    const pending = await useCase.execute(rollback);
    expect(pending.status).toBe(Status.PendingReference);
    expect(await balanceOf(wallet.id)).toBe('100.00');

    await useCase.execute(win);
    expect(await balanceOf(wallet.id)).toBe('125.00');

    await advanceToDue(pending.transactionId);
    await retrier.execute();

    expect((await readTx(pending.transactionId)).status).toBe(Status.Processed);
    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect((await movementsOf(db, wallet.id)).map((m) => [m.kind, m.direction])).toEqual([
      ['WIN', 'CREDIT'],
      ['ROLLBACK', 'DEBIT'],
    ]);
    await assertFinancialInvariants(db, wallet.id);
  });

  test('ROLLBACK of a REFUND that is itself still pending waits for the whole chain', async () => {
    await resetClock();
    const wallet = await openWallet('100.00');
    const bet = command(wallet, Kind.Bet);
    const refund = refundOf(wallet, bet);
    const rollback = command(wallet, Kind.Rollback, { referenceExternalTransactionId: refund.externalTransactionId });

    const pendingRollback = await useCase.execute(rollback);
    const pendingRefund = await useCase.execute(refund);
    expect([pendingRollback.status, pendingRefund.status]).toEqual([Status.PendingReference, Status.PendingReference]);
    await useCase.execute(bet);

    // Due times are 1s apart in submission order. One pass settles the refund; the rollback may need the next.
    clock.advance(10_000);
    for (let round = 0; round < 3; round++) {
      await retrier.execute();
      clock.advance(10_000);
    }

    expect((await readTx(pendingRefund.transactionId)).status).toBe(Status.Processed);
    const rolledBack = await readTx(pendingRollback.transactionId);
    // The BET was reversed by the REFUND, so the ROLLBACK reverses the REFUND: balance returns to the BET state.
    expect(rolledBack.status).toBe(Status.Processed);
    expect(await balanceOf(wallet.id)).toBe('75.00');
    await assertFinancialInvariants(db, wallet.id);
  });

  test('a submission replayed while pending returns the pending result, and the settled one afterwards', async () => {
    await resetClock();
    const wallet = await openWallet('100.00');
    const bet = command(wallet, Kind.Bet);
    const refund = refundOf(wallet, bet);

    const first = await useCase.execute(refund);
    const replayPending = await useCase.execute(refund);
    expect(replayPending).toMatchObject({ transactionId: first.transactionId, status: Status.PendingReference, idempotentReplay: true });
    expect(await eventCount(wallet.id, 'WagerTransactionPendingReference')).toBe(1);

    await useCase.execute(bet);
    await advanceToDue(first.transactionId);
    await retrier.execute();

    const replaySettled = await useCase.execute(refund);
    expect(replaySettled).toMatchObject({ transactionId: first.transactionId, status: Status.Processed, idempotentReplay: true });
    expect(replaySettled.balance?.toJSON().amount).toBe('100.00');
    expect(await movementsOf(db, wallet.id)).toHaveLength(2);
    await assertFinancialInvariants(db, wallet.id);
  });
});

describe('reference that never arrives', () => {
  test('backoff doubles up to the cap, attempts are persisted, and the limit ends in REJECTED with an event', async () => {
    await resetClock();
    const wallet = await openWallet('100.00');
    const bet = command(wallet, Kind.Bet);
    const refundCommand = refundOf(wallet, bet);
    const refund = await useCase.execute(refundCommand);

    const observed: Array<{ attempts: number; delayMs: number }> = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      await advanceToDue(refund.transactionId);
      const before = clock.now();
      expect(await retrier.execute()).toMatchObject({ claimed: 1, failed: 0 });
      const row = await readTx(refund.transactionId);
      expect(row.status).toBe(Status.PendingReference);
      observed.push({ attempts: row.attempts, delayMs: row.nextAttemptAt!.getTime() - before.getTime() });
    }
    // min(1000 * 2^n, 4000) with n the attempts already made: 2000, 4000, then capped at 4000.
    expect(observed).toEqual([
      { attempts: 1, delayMs: 2000 },
      { attempts: 2, delayMs: 4000 },
      { attempts: 3, delayMs: 4000 },
    ]);

    await advanceToDue(refund.transactionId);
    expect(await retrier.execute()).toMatchObject({ claimed: 1, failed: 0 });

    const rejected = await readTx(refund.transactionId);
    expect(rejected.status).toBe(Status.Rejected);
    expect(rejected.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(rejected.attempts).toBe(4);
    expect(rejected.nextAttemptAt).toBeUndefined();
    expect(rejected.processedAt).toEqual(clock.now());
    expect(rejected.observedBalance?.toJSON().amount).toBe('100.00');

    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect(await movementsOf(db, wallet.id)).toHaveLength(0);
    expect(await eventTypesFor(wallet.id)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    const [event] = await db.sql(`SELECT payload FROM outbox_messages WHERE event_type = 'WagerTransactionRejected' AND payload->'data'->>'walletId' = ?`, [wallet.id]);
    expect(event?.payload.data).toMatchObject({ transactionId: refund.transactionId, failureCode: 'REFERENCE_NOT_FOUND' });
    await assertFinancialInvariants(db, wallet.id);

    // Terminal: the retrier never touches it again, and a replay returns the rejection.
    clock.advance(3_600_000);
    expect(await retrier.execute()).toMatchObject({ claimed: 0 });
    expect(await useCase.execute(refundCommand)).toMatchObject({
      transactionId: refund.transactionId,
      status: Status.Rejected,
      failureCode: FailureCode.ReferenceNotFound,
      idempotentReplay: true,
    });
    expect(await eventCount(wallet.id, 'WagerTransactionRejected')).toBe(1);
  });

  test('a reference that exists in another provider does not count as the reference', async () => {
    await resetClock();
    const wallet = await openWallet('100.00');
    const bet = command(wallet, Kind.Bet, { providerId: 'provider-b', idempotencyKey: `provider-b:${randomUUID()}` });
    await useCase.execute(bet);
    const refund = await useCase.execute(refundOf(wallet, bet));
    expect(refund.status).toBe(Status.PendingReference);

    for (let i = 0; i < 4; i++) {
      await advanceToDue(refund.transactionId);
      await retrier.execute();
    }
    const rejected = await readTx(refund.transactionId);
    expect([rejected.status, rejected.failureCode]).toEqual([Status.Rejected, FailureCode.ReferenceNotFound]);
    expect(await balanceOf(wallet.id)).toBe('75.00');
    await assertFinancialInvariants(db, wallet.id);
  });
});

describe('reference that arrives invalid', () => {
  test('a reference with a different round rejects the reversal on the retry, with no effect', async () => {
    await resetClock();
    const wallet = await openWallet('100.00');
    const bet = command(wallet, Kind.Bet, { roundId: 'another-round' });
    const refund = await useCase.execute(refundOf(wallet, bet));
    expect(refund.status).toBe(Status.PendingReference);
    await useCase.execute(bet);

    await advanceToDue(refund.transactionId);
    await retrier.execute();

    const rejected = await readTx(refund.transactionId);
    expect([rejected.status, rejected.failureCode]).toEqual([Status.Rejected, FailureCode.ReferenceMismatch]);
    expect(await balanceOf(wallet.id)).toBe('75.00');
    expect(await movementsOf(db, wallet.id)).toHaveLength(1);
    expect(await eventCount(wallet.id, 'WagerTransactionRejected')).toBe(1);
    await assertFinancialInvariants(db, wallet.id);
  });

  test('a REFUND whose reference is a WIN is rejected on the retry as a wrong reference kind', async () => {
    await resetClock();
    const wallet = await openWallet('100.00');
    const win = command(wallet, Kind.Win);
    const refund = await useCase.execute(command(wallet, Kind.Refund, { referenceExternalTransactionId: win.externalTransactionId }));
    await useCase.execute(win);
    await advanceToDue(refund.transactionId);
    await retrier.execute();
    expect((await readTx(refund.transactionId)).failureCode).toBe(FailureCode.ReferenceKindInvalid);
    expect(await balanceOf(wallet.id)).toBe('125.00');
    await assertFinancialInvariants(db, wallet.id);
  });

  test('a reference that ended REJECTED rejects the reversal as not processed', async () => {
    await resetClock();
    const wallet = await openWallet('10.00');
    const bet = command(wallet, Kind.Bet);
    const refund = await useCase.execute(refundOf(wallet, bet));
    const rejectedBet = await useCase.execute(bet);
    expect(rejectedBet).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.InsufficientFunds });

    await advanceToDue(refund.transactionId);
    await retrier.execute();
    const rejected = await readTx(refund.transactionId);
    expect([rejected.status, rejected.failureCode]).toEqual([Status.Rejected, FailureCode.ReferenceNotProcessed]);
    expect(await balanceOf(wallet.id)).toBe('10.00');
    await assertFinancialInvariants(db, wallet.id);
  });

  test('a reference that was already reversed rejects the second reversal', async () => {
    await resetClock();
    const wallet = await openWallet('100.00');
    const bet = command(wallet, Kind.Bet);
    const rollback = command(wallet, Kind.Rollback, { referenceExternalTransactionId: bet.externalTransactionId });
    const pending = await useCase.execute(rollback);
    await useCase.execute(bet);
    // A REFUND of the same BET wins the race: only one financial reversal per original operation.
    await useCase.execute(refundOf(wallet, bet));

    await advanceToDue(pending.transactionId);
    await retrier.execute();
    const rejected = await readTx(pending.transactionId);
    expect([rejected.status, rejected.failureCode]).toEqual([Status.Rejected, FailureCode.AlreadyReversed]);
    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect(await movementsOf(db, wallet.id)).toHaveLength(2);
    await assertFinancialInvariants(db, wallet.id);
  });
});

describe('failures during the retry', () => {
  test('a transient failure after the real SQL rolls everything back, and the next run applies it once', async () => {
    await resetClock();
    const wallet = await openWallet('100.00');
    const bet = command(wallet, Kind.Bet);
    const refund = await useCase.execute(refundOf(wallet, bet));
    await useCase.execute(bet);
    await advanceToDue(refund.transactionId);

    let failures = 0;
    const flaky = uowWith((real) => ({
      outbox: overriding(real.outbox, {
        enqueue: async (record) => {
          await real.outbox.enqueue(record);
          failures += 1;
          throw new TransientInfrastructureError('simulated outage after the outbox insert');
        },
      }),
    }));
    const flakyRetrier = buildRetrier(flaky, buildUseCase(flaky));

    const result = await flakyRetrier.execute();
    expect(result).toMatchObject({ claimed: 1, failed: 1, failures: ['TransientInfrastructureError'] });
    expect(failures).toBeGreaterThan(0);

    // Wallet, ledger, transaction row and outbox all came back to the state before the attempt.
    const row = await readTx(refund.transactionId);
    expect([row.status, row.attempts]).toEqual([Status.PendingReference, 0]);
    expect(await balanceOf(wallet.id)).toBe('75.00');
    expect(await movementsOf(db, wallet.id)).toHaveLength(1);
    expect(await eventTypesFor(wallet.id)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionProcessed', 'WalletBalanceChanged']);
    await assertFinancialInvariants(db, wallet.id);

    // The failure was not an attempt: the same row is still due and the healthy retrier settles it exactly once.
    expect(await retrier.execute()).toMatchObject({ claimed: 1, failed: 0 });
    expect(await retrier.execute()).toMatchObject({ claimed: 0 });
    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect(await movementsOf(db, wallet.id)).toHaveLength(2);
    expect(await eventCount(wallet.id, 'WagerTransactionProcessed')).toBe(2);
    await assertFinancialInvariants(db, wallet.id);
  });

  test('a failure while loading the batch is reported by the caller, and one failing row does not block the others', async () => {
    await resetClock();
    const wallet = await openWallet('200.00');
    const bets = [command(wallet, Kind.Bet), command(wallet, Kind.Bet)];
    const refunds: Array<{ transactionId: string }> = [];
    for (const bet of bets) refunds.push(await useCase.execute(refundOf(wallet, bet)));
    for (const bet of bets) await useCase.execute(bet);
    clock.advance(5000);

    const poisoned = refunds[0]!.transactionId;
    const partial = uowWith((real) => ({
      ledger: overriding(real.ledger, {
        append: async (entry) => {
          if (entry.transactionId === poisoned) throw new TransientInfrastructureError('simulated failure for one row');
          await real.ledger.append(entry);
        },
      }),
    }));
    const result = await buildRetrier(partial, buildUseCase(partial)).execute();
    expect(result).toMatchObject({ claimed: 2, failed: 1 });

    expect((await readTx(poisoned)).status).toBe(Status.PendingReference);
    expect((await readTx(refunds[1]!.transactionId)).status).toBe(Status.Processed);
    expect(await balanceOf(wallet.id)).toBe('175.00');
    await assertFinancialInvariants(db, wallet.id);

    await retrier.execute();
    expect(await balanceOf(wallet.id)).toBe('200.00');
    await assertFinancialInvariants(db, wallet.id);
  });

  test('a permanent failure records FAILED with an audit trail and moves no money', async () => {
    await resetClock();
    const wallet = await openWallet('100.00');
    const bet = command(wallet, Kind.Bet);
    const refund = await useCase.execute(refundOf(wallet, bet));
    await useCase.execute(bet);
    await advanceToDue(refund.transactionId);

    const broken = uowWith((real) => ({
      ledger: overriding(real.ledger, {
        append: async () => {
          throw new PermanentInfrastructureError('simulated permanent failure');
        },
      }),
    }));
    const result = await buildRetrier(broken, buildUseCase(broken)).execute();
    expect(result).toMatchObject({ claimed: 1, failed: 1, failures: ['PermanentInfrastructureError'] });

    const failed = await readTx(refund.transactionId);
    expect([failed.status, failed.failureCode]).toEqual([Status.Failed, FailureCode.InternalError]);
    expect(await balanceOf(wallet.id)).toBe('75.00');
    expect(await movementsOf(db, wallet.id)).toHaveLength(1);
    expect(await retrier.execute()).toMatchObject({ claimed: 0 });
    await assertFinancialInvariants(db, wallet.id);
  });
});

describe('concurrent retriers', () => {
  test('two retriers blocked on the same wallet lock settle one pending reversal exactly once', async () => {
    await resetClock();
    const wallet = await openWallet('100.00');
    const bet = command(wallet, Kind.Bet);
    const refund = await useCase.execute(refundOf(wallet, bet));
    await useCase.execute(bet);
    await advanceToDue(refund.transactionId);

    const lock = await holdWalletLock(db, wallet.id);
    const runs = [retrier.execute(), buildRetrier(uow, buildUseCase(uow)).execute()];
    await waitForBlockedSessions(db, 2);
    await lock.release();
    const results = await Promise.all(runs);

    // Both claimed the row before the lock, and exactly one found it still pending.
    expect(results.map((r) => r.claimed)).toEqual([1, 1]);
    expect(results.every((r) => r.failed === 0)).toBe(true);
    expect((await readTx(refund.transactionId)).status).toBe(Status.Processed);
    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect(await movementsOf(db, wallet.id)).toHaveLength(2);
    expect(await eventCount(wallet.id, 'WagerTransactionProcessed')).toBe(2);
    expect(await eventCount(wallet.id, 'WalletBalanceChanged')).toBe(2);
    await assertFinancialInvariants(db, wallet.id);
  });

  test('three retriers draining many pending reversals credit each one exactly once', async () => {
    await resetClock();
    const COUNT = 24;
    const wallet = await openWallet('1000.00');
    const bets = Array.from({ length: COUNT }, () => command(wallet, Kind.Bet));
    const refunds = [];
    for (const bet of bets) refunds.push(await useCase.execute(refundOf(wallet, bet)));
    await Promise.all(bets.map((bet) => useCase.execute(bet)));
    expect(await balanceOf(wallet.id)).toBe('400.00');
    clock.advance(10_000);

    const drain = async () => {
      const mine = buildRetrier(uow, buildUseCase(uow), clock);
      let failed = 0;
      for (let round = 0; round < 50; round++) {
        const result = await mine.execute();
        failed += result.failed;
        if (result.claimed === 0) break;
      }
      return failed;
    };
    const failures = await Promise.all([drain(), drain(), drain()]);
    expect(failures).toEqual([0, 0, 0]);

    expect(await balanceOf(wallet.id)).toBe('1000.00');
    const movements = await movementsOf(db, wallet.id);
    expect(movements.filter((m) => m.kind === 'REFUND')).toHaveLength(COUNT);
    expect(movements.filter((m) => m.kind === 'BET')).toHaveLength(COUNT);
    for (const refund of refunds) expect((await readTx(refund.transactionId)).status).toBe(Status.Processed);
    expect(await eventCount(wallet.id, 'WagerTransactionProcessed')).toBe(2 * COUNT);
    await assertFinancialInvariants(db, wallet.id);
  }, 60_000);

  test('retriers on different wallets do not wait for each other', async () => {
    await resetClock();
    const held = await openWallet('100.00');
    const free = await openWallet('100.00');
    const heldBet = command(held, Kind.Bet);
    const freeBet = command(free, Kind.Bet);
    const heldRefund = await useCase.execute(refundOf(held, heldBet));
    const freeRefund = await useCase.execute(refundOf(free, freeBet));
    await useCase.execute(heldBet);
    await useCase.execute(freeBet);
    clock.advance(10_000);

    const lock = await holdWalletLock(db, held.id);
    const blocked = buildRetrier(uow, buildUseCase(uow)).execute();
    await waitForBlockedSessions(db, 1);
    // The free wallet is settled by another retriever while the first one is stuck on the held lock.
    await useCase.resumePending(freeRefund.transactionId);
    expect((await readTx(freeRefund.transactionId)).status).toBe(Status.Processed);
    expect((await readTx(heldRefund.transactionId)).status).toBe(Status.PendingReference);
    await lock.release();
    await blocked;
    expect(await balanceOf(held.id)).toBe('100.00');
    await assertFinancialInvariants(db, held.id);
    await assertFinancialInvariants(db, free.id);
  });
});

describe('recovery after a restart', () => {
  async function startRetrierApp(env: Record<string, string>): Promise<INestApplicationContext> {
    @Module({ imports: [ConfigModule.register(testEnv({ DATABASE_URL: db.url, ...env })), PersistenceModule, WageringModule, PendingReferenceRetrierModule] })
    class RetrierTestModule {}
    const app = await NestFactory.createApplicationContext(RetrierTestModule, { logger: false });
    app.enableShutdownHooks();
    return app;
  }

  async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
    const deadline = Date.now() + 20_000;
    let value = await read();
    while (!done(value)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(25);
      value = await read();
    }
    return value;
  }

  test('pending state survives a worker restart: attempts persist and the new worker settles the transaction', async () => {
    const wallet = await openWallet('100.00');
    const fast = {
      PENDING_REFERENCE_POLL_INTERVAL_MS: '20',
      PENDING_REFERENCE_RETRY_BASE_MS: '80',
      PENDING_REFERENCE_RETRY_MAX_MS: '160',
      PENDING_REFERENCE_MAX_ATTEMPTS: '1000',
    };
    const first = await startRetrierApp(fast);
    const submit = first.get(ProcessWagerTransaction);
    const bet = command(wallet, Kind.Bet);
    const refund = await submit.execute(refundOf(wallet, bet));
    expect(refund.status).toBe(Status.PendingReference);

    // The reference is still missing, so worker one keeps retrying and persisting attempts.
    const retried = await waitFor(() => readTx(refund.transactionId), (tx) => tx.attempts >= 2, 'worker one to retry');
    expect(retried.status).toBe(Status.PendingReference);
    await first.close();

    const stopped = await readTx(refund.transactionId);
    expect(stopped.status).toBe(Status.PendingReference);
    expect(stopped.attempts).toBeGreaterThanOrEqual(retried.attempts);
    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect(await movementsOf(db, wallet.id)).toHaveLength(0);

    // Nobody is running now. The reference arrives, then a brand new worker starts from the persisted state.
    const second = await startRetrierApp(fast);
    try {
      await second.get(ProcessWagerTransaction).execute(bet);
      const settled = await waitFor(() => readTx(refund.transactionId), (tx) => tx.status !== Status.PendingReference, 'worker two to settle');
      expect(settled.status).toBe(Status.Processed);
      expect(settled.attempts).toBeGreaterThanOrEqual(stopped.attempts);
    } finally {
      await second.close();
    }
    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect((await movementsOf(db, wallet.id)).map((m) => m.kind)).toEqual(['BET', 'REFUND']);
    expect(await eventCount(wallet.id, 'WagerTransactionPendingReference')).toBe(1);
    await assertFinancialInvariants(db, wallet.id);
  }, 60_000);

  test('closing the worker waits for the operation in progress and starts no other', async () => {
    await resetClock();
    const wallet = await openWallet('100.00');
    const bet = command(wallet, Kind.Bet);
    const refund = await useCase.execute(refundOf(wallet, bet));
    await useCase.execute(bet);
    // Due for the real clock the worker uses, whatever the manual clock says.
    await db.sql(`UPDATE wager_transactions SET next_attempt_at = now() - interval '1 second' WHERE id = ?`, [refund.transactionId]);

    // The wallet lock holds the retry in progress, so the shutdown demonstrably arrives mid-operation.
    const lock = await holdWalletLock(db, wallet.id);
    const app = await startRetrierApp({ PENDING_REFERENCE_POLL_INTERVAL_MS: '20' });
    await waitForBlockedSessions(db, 1);

    const closing = app.close().then(() => 'closed');
    expect(await Promise.race([closing, Bun.sleep(200).then(() => 'still closing')])).toBe('still closing');
    expect((await readTx(refund.transactionId)).status).toBe(Status.PendingReference);

    await lock.release();
    expect(await closing).toBe('closed');

    // The operation in progress finished completely, and nothing else started after the shutdown.
    expect((await readTx(refund.transactionId)).status).toBe(Status.Processed);
    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect(await movementsOf(db, wallet.id)).toHaveLength(2);
    await assertFinancialInvariants(db, wallet.id);
  }, 60_000);
});
