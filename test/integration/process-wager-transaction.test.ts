import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { WageringPersistence } from '../../src/app/wagering/application/ports/wagering-persistence.port';
import {
  type ProcessWagerCommand,
  type ProcessWagerResult,
  ProcessWagerTransaction,
} from '../../src/app/wagering/application/process-wager-transaction.use-case';
import { wagerPayloadHash } from '../../src/app/wagering/application/wager-payload-hash';
import { FailureCode } from '../../src/app/wagering/domain/failure-code';
import { WagerProcessor } from '../../src/app/wagering/domain/wager-processor';
import {
  INTERNAL_PROVIDER_ID,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/app/wagering/domain/wager-transaction.entity';
import { IdempotencyConflictError, InvalidWagerTransactionError } from '../../src/app/wagering/domain/wagering-errors';
import { WageringModule } from '../../src/app/wagering/wagering.module';
import { LedgerDirection } from '../../src/app/wallet/domain/ledger-entry.entity';
import { Wallet } from '../../src/app/wallet/domain/wallet.entity';
import { WalletNotFoundError } from '../../src/app/wallet/domain/wallet-errors';
import { MikroOrmUnitOfWork } from '../../src/database/mikro-orm-unit-of-work';
import { createPersistenceContext, PERSISTENCE_SCHEMAS, PersistenceModule } from '../../src/persistence.module';
import type { Clock } from '../../src/shared/application/clock.port';
import {
  PersistenceConstraintError,
  TransientInfrastructureError,
} from '../../src/shared/application/infrastructure-error';
import type { UnitOfWork } from '../../src/shared/application/unit-of-work.port';
import { Money, InvalidMoneyError } from '../../src/shared/domain/money';
import { ConfigModule } from '../../src/shared/infrastructure/config.module';
import { systemClock, uuidV7Generator } from '../../src/shared/infrastructure/system-providers';
import { testEnv } from '../support/env';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

// Pré-requisito: `docker compose up -d postgres`. PostgreSQL real e descartável, sem mocks de banco.
// Cada teste abre as próprias wallets, então não depende da ordem. Os testes de falha só trocam um
// repositório por um que falha depois de executar o SQL real.
const CONCURRENCY_TIMEOUT = 30_000;
const PROVIDER = 'provider-a';
const ROUND = 'round-1';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

let db: TestDatabase;
let uow: UnitOfWork<WageringPersistence>;
let useCase: ProcessWagerTransaction;

const buildUseCase = (unitOfWork: UnitOfWork<WageringPersistence>, clock: Clock = systemClock) =>
  new ProcessWagerTransaction(unitOfWork, new WagerProcessor(), clock, uuidV7Generator);

/** Unidade de trabalho real em que alguns repositórios falham de propósito. */
const uowWith = (override: (real: WageringPersistence) => Partial<WageringPersistence>, lockTimeoutMs = 5000) =>
  new MikroOrmUnitOfWork<WageringPersistence>(
    db.orm,
    (em) => {
      const real = createPersistenceContext(em);
      return { ...real, ...override(real) };
    },
    lockTimeoutMs,
  );

/** O repositório real, com alguns métodos trocados. */
const overriding = <T extends object>(real: T, methods: Partial<T>): T => Object.assign(Object.create(real), methods);

beforeAll(async () => {
  db = await createTestDatabase({ entities: PERSISTENCE_SCHEMAS });
  await db.orm.migrator.up();
  uow = new MikroOrmUnitOfWork(db.orm, createPersistenceContext, 5000);
  useCase = buildUseCase(uow);
});
afterAll(async () => { await db.drop(); });

/** Abre a wallet como o fluxo real fará: com a OPENING e o lançamento, para o invariante valer desde o início. */
async function openWallet(amount = '100.00', currency = 'BRL'): Promise<Wallet> {
  const money = Money.from({ amount, currency });
  const at = new Date();
  const wallet = Wallet.open({ id: randomUUID(), playerId: randomUUID(), initialBalance: money, at });
  if (money.isZero()) {
    await uow.run((c) => c.wallets.insert(wallet));
    return wallet;
  }
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
    idempotencyKey: `${overrides.providerId ?? PROVIDER}:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: ROUND,
    gameId: 'fortune-chimp',
    kind,
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

/** Espera até uma sessão deste banco estar de fato bloqueada em um lock. Com prazo, sem sleep fixo. */
async function waitForBlockedSession(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await db.sql(
      `SELECT count(*)::int AS blocked FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if (row?.blocked > 0) return;
    await Bun.sleep(20);
  }
  throw new Error('no session was blocked in time');
}

const moneyOf = (result: ProcessWagerResult) => result.balance?.toJSON().amount;

async function expectError<E extends Error>(action: Promise<unknown>, type: new (...args: any[]) => E): Promise<E> {
  let caught: unknown;
  try {
    await action;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(type);
  return caught as E;
}

const readWallet = async (id: string) => (await uow.run((c) => c.wallets.findById(id)))!;
const readTx = async (id: string) => (await uow.run((c) => c.transactions.findById(id)))!;

async function ledgerEntries(walletId: string) {
  return (await uow.run((c) => c.ledger.listByWallet(walletId, { limit: 1000 }))).entries;
}

const movements = async (walletId: string) => (await ledgerEntries(walletId)).length - 1;

async function eventsOf(walletId: string) {
  const rows = await db.sql(
    `SELECT event_type, aggregate_id, payload FROM outbox_messages WHERE payload->'data'->>'walletId' = ?`,
    [walletId],
  );
  return rows as Array<{ event_type: string; aggregate_id: string; payload: any }>;
}

const eventTypes = async (walletId: string) => (await eventsOf(walletId)).map((e) => e.event_type).sort();

/**
 * Invariante universal: saldo igual à soma assinada do ledger; versão igual à maior do ledger
 * (ou 1, sem lançamentos); aritmética encadeada; todo lançamento aponta para uma transação PROCESSED.
 */
async function assertConsistent(walletId: string): Promise<void> {
  const wallet = await readWallet(walletId);
  const totals = await uow.run((c) => c.ledger.totals(walletId, wallet.currency));
  expect(totals.signedTotal.equals(wallet.balance)).toBe(true);
  const entries = await ledgerEntries(walletId);
  expect(wallet.version).toBe(Math.max(1, ...entries.map((e) => e.walletVersion)));
  const orphan = await db.sql(
    `SELECT l.id FROM wallet_ledger_entries l JOIN wager_transactions t ON t.id = l.transaction_id
     WHERE l.wallet_id = ? AND t.status <> 'PROCESSED'`,
    [walletId],
  );
  expect(orphan).toHaveLength(0);
  for (let i = 1; i < entries.length; i++) {
    expect(entries[i]!.balanceBefore.equals(entries[i - 1]!.balanceAfter)).toBe(true);
  }
}

async function expectNoEffect(wallet: Wallet, balance: string, version: number, movementCount: number) {
  const current = await readWallet(wallet.id);
  expect(current.balance.toJSON().amount).toBe(balance);
  expect(current.version).toBe(version);
  expect(await movements(wallet.id)).toBe(movementCount);
  await assertConsistent(wallet.id);
}

describe('operations', () => {
  test('BET applied: debits, records the entry, bumps the version and records the events', async () => {
    const wallet = await openWallet();
    const result = await useCase.execute(command(wallet, Kind.Bet));
    expect(result).toMatchObject({ status: Status.Processed, idempotentReplay: false });
    expect(moneyOf(result)).toBe('75.00');
    expect(result.failureCode).toBeUndefined();

    const current = await readWallet(wallet.id);
    expect(current.balance.toJSON().amount).toBe('75.00');
    expect(current.version).toBe(2);
    const entry = (await ledgerEntries(wallet.id)).at(-1)!;
    expect(entry).toMatchObject({ direction: 'DEBIT', transactionId: result.transactionId, walletVersion: 2 });
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('75.00');
    expect((await readTx(result.transactionId)).observedBalance?.toJSON().amount).toBe('75.00');
    expect(await eventTypes(wallet.id)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    await assertConsistent(wallet.id);
  });

  test('BET without funds: REJECTED, audited, without an entry or a version', async () => {
    const wallet = await openWallet('10.00');
    const result = await useCase.execute(command(wallet, Kind.Bet));
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: 'INSUFFICIENT_FUNDS', idempotentReplay: false });
    expect(moneyOf(result)).toBe('10.00');
    await expectNoEffect(wallet, '10.00', 1, 0);
    expect((await readTx(result.transactionId)).status).toBe(Status.Rejected);
    expect(await eventTypes(wallet.id)).toEqual(['WagerTransactionRejected']);
  });

  test('a BET of the whole balance reaches zero, never negative', async () => {
    const wallet = await openWallet('25.00');
    expect(moneyOf(await useCase.execute(command(wallet, Kind.Bet)))).toBe('0.00');
    await expectNoEffect(wallet, '0.00', 2, 1);
  });

  test('WIN credits, with or without a reference, and the amount is free', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet);
    await useCase.execute(bet);
    const linked = await useCase.execute(
      command(wallet, Kind.Win, { money: { amount: '60.00', currency: 'BRL' }, referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(moneyOf(linked)).toBe('135.00');
    expect((await readTx(linked.transactionId)).referenceTransactionId).toBeDefined();
    expect(moneyOf(await useCase.execute(command(wallet, Kind.Win)))).toBe('160.00');
    expect((await ledgerEntries(wallet.id)).at(-1)!.direction).toBe(LedgerDirection.Credit);
    await assertConsistent(wallet.id);
  });

  test('LOSS records without moving balance: no entry, no version, only the Processed event', async () => {
    const wallet = await openWallet();
    const result = await useCase.execute(command(wallet, Kind.Loss));
    expect(result.status).toBe(Status.Processed);
    expect(moneyOf(result)).toBe('100.00');
    await expectNoEffect(wallet, '100.00', 1, 0);
    expect(await eventTypes(wallet.id)).toEqual(['WagerTransactionProcessed']);
  });

  test('LOSS accepts a zero amount', async () => {
    const wallet = await openWallet();
    const result = await useCase.execute(command(wallet, Kind.Loss, { money: { amount: '0.00', currency: 'BRL' } }));
    expect(result.status).toBe(Status.Processed);
  });

  test('a valid REFUND returns the amount of the BET', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet);
    const applied = await useCase.execute(bet);
    const result = await useCase.execute(command(wallet, Kind.Refund, { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(result.status).toBe(Status.Processed);
    expect(moneyOf(result)).toBe('100.00');
    expect((await readTx(result.transactionId)).referenceTransactionId).toBe(applied.transactionId);
    expect((await readWallet(wallet.id)).version).toBe(3);
    await assertConsistent(wallet.id);
  });

  test('a valid ROLLBACK applies the inverse of the reference: BET credits, WIN and REFUND debit', async () => {
    const wallet = await openWallet();
    const reference = (id: string) => ({ referenceExternalTransactionId: id });

    const bet = command(wallet, Kind.Bet);
    await useCase.execute(bet);
    expect(moneyOf(await useCase.execute(command(wallet, Kind.Rollback, reference(bet.externalTransactionId))))).toBe('100.00');

    const win = command(wallet, Kind.Win);
    await useCase.execute(win);
    expect(moneyOf(await useCase.execute(command(wallet, Kind.Rollback, reference(win.externalTransactionId))))).toBe('100.00');
    expect((await ledgerEntries(wallet.id)).at(-1)!.direction).toBe(LedgerDirection.Debit);

    const secondBet = command(wallet, Kind.Bet);
    await useCase.execute(secondBet);
    const refund = command(wallet, Kind.Refund, reference(secondBet.externalTransactionId));
    await useCase.execute(refund);
    expect(moneyOf(await useCase.execute(command(wallet, Kind.Rollback, reference(refund.externalTransactionId))))).toBe('75.00');
    await assertConsistent(wallet.id);
  });

  test('wallet of another player: REJECTED, with the observed balance', async () => {
    const wallet = await openWallet();
    const result = await useCase.execute(command(wallet, Kind.Bet, { playerId: randomUUID() }));
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: 'PLAYER_WALLET_MISMATCH' });
    await expectNoEffect(wallet, '100.00', 1, 0);
  });

  test('different currency: REJECTED, and the observed balance stays in the wallet currency', async () => {
    const wallet = await openWallet();
    const result = await useCase.execute(command(wallet, Kind.Bet, { money: { amount: '25.00', currency: 'USD' } }));
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: 'CURRENCY_MISMATCH' });
    expect(result.balance?.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect((await readTx(result.transactionId)).observedBalance?.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    await expectNoEffect(wallet, '100.00', 1, 0);
  });

  test('credit past the NUMERIC(20,2) limit: REJECTED, no effect', async () => {
    const wallet = await openWallet('999999999999999999.99');
    const result = await useCase.execute(command(wallet, Kind.Win, { money: { amount: '0.01', currency: 'BRL' } }));
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: 'BALANCE_LIMIT_EXCEEDED' });
    await expectNoEffect(wallet, '999999999999999999.99', 1, 0);
  });

  test('values at the limits pass without losing precision', async () => {
    const wallet = await openWallet('999999999999999999.99');
    const result = await useCase.execute(command(wallet, Kind.Bet, { money: { amount: '0.01', currency: 'BRL' } }));
    expect(moneyOf(result)).toBe('999999999999999999.98');
    await assertConsistent(wallet.id);
  });
});

describe('input validation', () => {
  test('OPENING is never accepted as an external operation, and nothing is written', async () => {
    const wallet = await openWallet();
    const external = command(wallet, Kind.Opening);
    await expectError(useCase.execute(external), InvalidWagerTransactionError);
    expect(await uow.run((c) => c.transactions.findByIdempotencyKey(external.idempotencyKey))).toBeUndefined();
  });

  test('the reserved provider is refused on input', async () => {
    const wallet = await openWallet();
    await expectError(useCase.execute(command(wallet, Kind.Bet, { providerId: INTERNAL_PROVIDER_ID })), InvalidWagerTransactionError);
  });

  test('the deterministic identity of the OPENING is not reused', async () => {
    const wallet = await openWallet();
    const opening = `opening:${wallet.id}`;
    await expectError(
      useCase.execute(command(wallet, Kind.Bet, { idempotencyKey: opening })),
      IdempotencyConflictError,
    );
    await expectNoEffect(wallet, '100.00', 1, 0);
  });

  test.each([['25'], ['25.5'], ['25.555'], ['-25.00'], ['1e2'], ['']])('a value outside the contract is refused: "%s"', async (amount) => {
    const wallet = await openWallet();
    await expectError(useCase.execute(command(wallet, Kind.Bet, { money: { amount, currency: 'BRL' } })), InvalidMoneyError);
    await expectNoEffect(wallet, '100.00', 1, 0);
  });

  test('zero is refused for operations that move balance; so is a REFUND without a reference', async () => {
    const wallet = await openWallet();
    await expectError(useCase.execute(command(wallet, Kind.Bet, { money: { amount: '0.00', currency: 'BRL' } })), InvalidWagerTransactionError);
    await expectError(useCase.execute(command(wallet, Kind.Refund)), InvalidWagerTransactionError);
  });

  test('nonexistent wallet: WALLET_NOT_FOUND, nothing persisted', async () => {
    const wallet = await openWallet();
    const missing = command(wallet, Kind.Bet, { walletId: randomUUID() });
    const error = await expectError(useCase.execute(missing), WalletNotFoundError);
    expect(error.code).toBe('WALLET_NOT_FOUND');
    expect(await uow.run((c) => c.transactions.findByIdempotencyKey(missing.idempotencyKey))).toBeUndefined();
    expect(await db.sql(`SELECT 1 FROM outbox_messages WHERE payload->'data'->>'walletId' = ?`, [missing.walletId])).toHaveLength(0);
  });
});

describe('references', () => {
  test('missing: PENDING_REFERENCE scheduled, without balance, ledger entry or version', async () => {
    const wallet = await openWallet();
    const before = new Date();
    const clock: Clock = { now: () => before };
    const result = await buildUseCase(uow, clock).execute(
      command(wallet, Kind.Refund, { referenceExternalTransactionId: 'ainda-nao-chegou' }),
    );
    expect(result).toMatchObject({ status: Status.PendingReference, idempotentReplay: false });
    expect(result.balance).toBeUndefined();
    await expectNoEffect(wallet, '100.00', 1, 0);

    const stored = await readTx(result.transactionId);
    expect(stored.observedBalance).toBeUndefined();
    expect(stored.attempts).toBe(0);
    expect(stored.nextAttemptAt?.getTime()).toBe(before.getTime() + 5000);
    expect(await eventTypes(wallet.id)).toEqual(['WagerTransactionPendingReference']);
  });

  test('a pending transaction becomes available to the future retrier only after its deadline', async () => {
    const wallet = await openWallet();
    const at = new Date('2000-01-01T00:00:00.000Z');
    const { transactionId } = await buildUseCase(uow, { now: () => at }).execute(
      command(wallet, Kind.Win, { referenceExternalTransactionId: 'nao-chegou' }),
    );
    const due = (now: Date) => uow.run((c) => c.transactions.findDuePendingIds(now, 100));
    expect(await due(new Date('2000-01-01T00:00:04.000Z'))).not.toContain(transactionId);
    expect(await due(new Date('2000-01-01T00:00:05.000Z'))).toContain(transactionId);
  });

  test('the domain resumes the persisted pending transaction when the reference arrives', async () => {
    const wallet = await openWallet();
    const betId = randomUUID();
    const pending = await useCase.execute(command(wallet, Kind.Refund, { referenceExternalTransactionId: betId }));
    const bet = await useCase.execute(command(wallet, Kind.Bet, { externalTransactionId: betId }));
    expect(bet.status).toBe(Status.Processed);
    const resumed = await uow.run(async (c) => {
      const lockedWallet = (await c.wallets.findByIdForUpdate(wallet.id))!;
      const reference = await c.transactions.findByExternalId(PROVIDER, betId);
      return new WagerProcessor().process({
        wallet: lockedWallet,
        transaction: (await c.transactions.findByIdForUpdate(pending.transactionId))!,
        reference,
        ledgerEntryId: randomUUID(),
        at: new Date(),
      });
    });
    expect(resumed.outcome).toBe('APPLIED');
  });

  test('a reference that only exists in another provider counts as missing', async () => {
    const wallet = await openWallet();
    const betOtherProvider = command(wallet, Kind.Bet, { providerId: 'provider-b' });
    await useCase.execute(betOtherProvider);
    const result = await useCase.execute(
      command(wallet, Kind.Refund, { referenceExternalTransactionId: betOtherProvider.externalTransactionId }),
    );
    expect(result.status).toBe(Status.PendingReference);
    await assertConsistent(wallet.id);
  });

  test('reference still pending: the operation waits too', async () => {
    const wallet = await openWallet();
    const win = command(wallet, Kind.Win, { referenceExternalTransactionId: 'bet-que-nao-chegou' });
    await useCase.execute(win);
    const result = await useCase.execute(command(wallet, Kind.Rollback, { referenceExternalTransactionId: win.externalTransactionId }));
    expect(result.status).toBe(Status.PendingReference);
    await expectNoEffect(wallet, '100.00', 1, 0);
  });

  test('incompatible kind: REFUND of a WIN is REFERENCE_KIND_INVALID', async () => {
    const wallet = await openWallet();
    const win = command(wallet, Kind.Win);
    await useCase.execute(win);
    const result = await useCase.execute(command(wallet, Kind.Refund, { referenceExternalTransactionId: win.externalTransactionId }));
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: 'REFERENCE_KIND_INVALID' });
    await expectNoEffect(wallet, '125.00', 2, 1);
  });

  test('a different round is REFERENCE_MISMATCH', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet);
    await useCase.execute(bet);
    const result = await useCase.execute(
      command(wallet, Kind.Refund, { referenceExternalTransactionId: bet.externalTransactionId, roundId: 'round-2' }),
    );
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: 'REFERENCE_MISMATCH' });
    await expectNoEffect(wallet, '75.00', 2, 1);
  });

  test('a different wallet is REFERENCE_MISMATCH, touching neither of the two', async () => {
    const [wallet, other] = [await openWallet(), await openWallet()];
    const bet = command(wallet, Kind.Bet);
    await useCase.execute(bet);
    const result = await useCase.execute(command(other, Kind.Refund, { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: 'REFERENCE_MISMATCH' });
    await expectNoEffect(wallet, '75.00', 2, 1);
    await expectNoEffect(other, '100.00', 1, 0);
  });

  test('a different amount in the reversal is AMOUNT_MISMATCH', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet);
    await useCase.execute(bet);
    const result = await useCase.execute(
      command(wallet, Kind.Refund, { referenceExternalTransactionId: bet.externalTransactionId, money: { amount: '10.00', currency: 'BRL' } }),
    );
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: 'AMOUNT_MISMATCH' });
    await expectNoEffect(wallet, '75.00', 2, 1);
  });

  test('a REJECTED reference is REFERENCE_NOT_PROCESSED', async () => {
    const wallet = await openWallet('10.00');
    const bet = command(wallet, Kind.Bet);
    await useCase.execute(bet);
    const result = await useCase.execute(command(wallet, Kind.Refund, { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: 'REFERENCE_NOT_PROCESSED' });
    await expectNoEffect(wallet, '10.00', 1, 0);
  });

  test('duplicate reversal: a repeated REFUND is ALREADY_REVERSED and does not credit again', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet);
    await useCase.execute(bet);
    const reference = { referenceExternalTransactionId: bet.externalTransactionId };
    await useCase.execute(command(wallet, Kind.Refund, reference));
    const second = await useCase.execute(command(wallet, Kind.Refund, reference));
    expect(second).toMatchObject({ status: Status.Rejected, failureCode: 'ALREADY_REVERSED' });
    expect(moneyOf(second)).toBe('100.00');
    await expectNoEffect(wallet, '100.00', 3, 2);
  });

  test('REFUND and ROLLBACK of the same operation are mutually exclusive', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet);
    await useCase.execute(bet);
    const reference = { referenceExternalTransactionId: bet.externalTransactionId };
    await useCase.execute(command(wallet, Kind.Refund, reference));
    expect(await useCase.execute(command(wallet, Kind.Rollback, reference))).toMatchObject({ failureCode: 'ALREADY_REVERSED' });
    await expectNoEffect(wallet, '100.00', 3, 2);
  });

  test('a reversal that would leave a negative balance: REVERSAL_INSUFFICIENT_FUNDS, distinct code, audited', async () => {
    const wallet = await openWallet('0.00');
    const win = command(wallet, Kind.Win);
    await useCase.execute(win);
    await useCase.execute(command(wallet, Kind.Bet, { money: { amount: '20.00', currency: 'BRL' } }));
    const result = await useCase.execute(command(wallet, Kind.Rollback, { referenceExternalTransactionId: win.externalTransactionId }));
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: 'REVERSAL_INSUFFICIENT_FUNDS' });
    expect(moneyOf(result)).toBe('5.00');
    expect((await readTx(result.transactionId)).status).toBe(Status.Rejected);
    const current = await readWallet(wallet.id);
    expect(current.balance.toJSON().amount).toBe('5.00');
    await assertConsistent(wallet.id);
  });

  test('a rejected reversal does not prevent the valid reversal afterwards', async () => {
    const wallet = await openWallet('0.00');
    const win = command(wallet, Kind.Win);
    await useCase.execute(win);
    await useCase.execute(command(wallet, Kind.Bet, { money: { amount: '20.00', currency: 'BRL' } }));
    const reference = { referenceExternalTransactionId: win.externalTransactionId };
    await useCase.execute(command(wallet, Kind.Rollback, reference));
    await useCase.execute(command(wallet, Kind.Win, { money: { amount: '30.00', currency: 'BRL' } }));
    expect(moneyOf(await useCase.execute(command(wallet, Kind.Rollback, reference)))).toBe('10.00');
    await assertConsistent(wallet.id);
  });
});

describe('idempotency', () => {
  test('an identical replay returns the original result with the balance of the time, without effects', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet);
    const first = await useCase.execute(bet);
    await useCase.execute(command(wallet, Kind.Win, { money: { amount: '500.00', currency: 'BRL' } }));
    const eventsBefore = (await eventsOf(wallet.id)).length;

    const replay = await useCase.execute(bet);
    expect(replay).toMatchObject({ transactionId: first.transactionId, status: Status.Processed, idempotentReplay: true });
    expect(moneyOf(replay)).toBe('75.00');
    expect((await readWallet(wallet.id)).balance.toJSON().amount).toBe('575.00');
    expect(await movements(wallet.id)).toBe(2);
    expect(await eventsOf(wallet.id)).toHaveLength(eventsBefore);
    await assertConsistent(wallet.id);
  });

  test('a replay of REJECTED returns the same rejection, even if there were funds now', async () => {
    const wallet = await openWallet('10.00');
    const bet = command(wallet, Kind.Bet);
    const first = await useCase.execute(bet);
    await useCase.execute(command(wallet, Kind.Win, { money: { amount: '100.00', currency: 'BRL' } }));
    const replay = await useCase.execute(bet);
    expect(replay).toMatchObject({
      transactionId: first.transactionId,
      status: Status.Rejected,
      failureCode: 'INSUFFICIENT_FUNDS',
      idempotentReplay: true,
    });
    expect(moneyOf(replay)).toBe('10.00');
    expect((await readTx(first.transactionId)).status).toBe(Status.Rejected);
  });

  test('a replay of LOSS returns the observed balance, without a new event', async () => {
    const wallet = await openWallet();
    const loss = command(wallet, Kind.Loss);
    await useCase.execute(loss);
    await useCase.execute(command(wallet, Kind.Bet));
    const replay = await useCase.execute(loss);
    expect(replay.idempotentReplay).toBe(true);
    expect(moneyOf(replay)).toBe('100.00');
  });

  test('a replay of PENDING_REFERENCE preserves identity and state, without inventing a balance', async () => {
    const wallet = await openWallet();
    const refund = command(wallet, Kind.Refund, { referenceExternalTransactionId: 'ausente' });
    const first = await useCase.execute(refund);
    const replay = await useCase.execute(refund);
    expect(replay).toMatchObject({ transactionId: first.transactionId, status: Status.PendingReference, idempotentReplay: true });
    expect(replay.balance).toBeUndefined();
    expect((await eventsOf(wallet.id))).toHaveLength(1);
  });

  test('transport metadata does not take part: a different correlationId is still a replay', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet, { correlationId: 'a', causationId: 'msg-1' });
    await useCase.execute(bet);
    const replay = await useCase.execute({ ...bet, correlationId: 'b', causationId: 'msg-2' });
    expect(replay.idempotentReplay).toBe(true);
  });

  test('the envelope keeps correlation and cause, with the money as a string', async () => {
    const wallet = await openWallet();
    await useCase.execute(command(wallet, Kind.Bet, { correlationId: 'corr-1', causationId: 'msg-1' }));
    const [changed] = (await eventsOf(wallet.id)).filter((e) => e.event_type === 'WalletBalanceChanged');
    expect(changed!.aggregate_id).toBe(wallet.id);
    expect(changed!.payload).toMatchObject({
      correlationId: 'corr-1',
      causationId: 'msg-1',
      version: 1,
      data: { money: { amount: '25.00', currency: 'BRL' }, balanceAfter: { amount: '75.00', currency: 'BRL' }, walletVersion: 2 },
    });
  });

  test('conflict: same key with a different payload, no effect and the original is unchanged', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet);
    const first = await useCase.execute(bet);
    const error = await expectError(
      useCase.execute({ ...bet, money: { amount: '26.00', currency: 'BRL' } }),
      IdempotencyConflictError,
    );
    expect(error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    await expectNoEffect(wallet, '75.00', 2, 1);
    expect((await readTx(first.transactionId)).money.toJSON().amount).toBe('25.00');
  });

  test('conflict: same provider external id with another key', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet);
    await useCase.execute(bet);
    await expectError(useCase.execute({ ...bet, idempotencyKey: 'outra-chave' }), IdempotencyConflictError);
    await expectNoEffect(wallet, '75.00', 2, 1);
  });

  test('a conflict takes precedence over WALLET_NOT_FOUND', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet);
    await useCase.execute(bet);
    await expectError(useCase.execute({ ...bet, walletId: randomUUID() }), IdempotencyConflictError);
  });

  test('the same external id in different providers are different operations', async () => {
    const wallet = await openWallet();
    const externalTransactionId = randomUUID();
    await useCase.execute(command(wallet, Kind.Bet, { externalTransactionId }));
    const other = await useCase.execute(command(wallet, Kind.Bet, { externalTransactionId, providerId: 'provider-b' }));
    expect(other).toMatchObject({ status: Status.Processed, idempotentReplay: false });
    await expectNoEffect(wallet, '50.00', 3, 2);
  });

  test('the stored hash is that of the canonical payload', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet);
    const { transactionId } = await useCase.execute(bet);
    expect((await readTx(transactionId)).payloadHash).toBe(wagerPayloadHash({ ...bet, money: brl('25.00') }));
  });
});

describe('concurrency (real PostgreSQL)', () => {
  test('mandatory scenario: 100.00 and two BETs of 80.00', async () => {
    const wallet = await openWallet();
    const results = await Promise.all([
      useCase.execute(command(wallet, Kind.Bet, { money: { amount: '80.00', currency: 'BRL' } })),
      useCase.execute(command(wallet, Kind.Bet, { money: { amount: '80.00', currency: 'BRL' } })),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([Status.Processed, Status.Rejected]);
    expect(results.find((r) => r.status === Status.Rejected)?.failureCode).toBe(FailureCode.InsufficientFunds);
    await expectNoEffect(wallet, '20.00', 2, 1);
  }, CONCURRENCY_TIMEOUT);

  test('same key 50 times at once: a single effect and 49 replays of the same result', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet);
    const results = await Promise.all(Array.from({ length: 50 }, () => useCase.execute(bet)));
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(new Set(results.map(moneyOf))).toEqual(new Set(['75.00']));
    await expectNoEffect(wallet, '75.00', 2, 1);
    expect(await eventsOf(wallet.id)).toHaveLength(2);
  }, CONCURRENCY_TIMEOUT);

  test('distinct simultaneous operations on the same wallet: no lost update and never negative', async () => {
    const wallet = await openWallet('100.00');
    const commands = [
      ...Array.from({ length: 12 }, () => command(wallet, Kind.Bet, { money: { amount: '10.00', currency: 'BRL' } })),
      ...Array.from({ length: 6 }, () => command(wallet, Kind.Win, { money: { amount: '1.00', currency: 'BRL' } })),
      ...Array.from({ length: 6 }, () => command(wallet, Kind.Loss, { money: { amount: '1.00', currency: 'BRL' } })),
    ];
    const results = await Promise.all(commands.map((c) => useCase.execute(c)));
    const processed = (kind: Kind) =>
      results.filter((r, i) => commands[i]!.kind === kind && r.status === Status.Processed).length;
    const expected = 100 - processed(Kind.Bet) * 10 + processed(Kind.Win);
    const current = await readWallet(wallet.id);
    expect(current.balance.equals(brl(`${expected}.00`))).toBe(true);
    expect(await movements(wallet.id)).toBe(processed(Kind.Bet) + processed(Kind.Win));
    expect(current.version).toBe(1 + processed(Kind.Bet) + processed(Kind.Win));
    await assertConsistent(wallet.id);
  }, CONCURRENCY_TIMEOUT);

  test('the same wallet waits; different wallets do not block each other', async () => {
    const [held, free] = [await openWallet(), await openWallet()];
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const lockAcquired = new Promise<void>((resolve) => { locked = resolve; });
    const holder = uow.run(async (c) => {
      await c.wallets.findByIdForUpdate(held.id);
      locked();
      await released;
    });
    await lockAcquired;

    const blocked = useCase.execute(command(held, Kind.Bet));
    await waitForBlockedSession();
    expect((await useCase.execute(command(free, Kind.Bet))).status).toBe(Status.Processed);
    release();
    await holder;
    expect(moneyOf(await blocked)).toBe('75.00');
    await assertConsistent(held.id);
    await assertConsistent(free.id);
  }, CONCURRENCY_TIMEOUT);

  test('many wallets in parallel: each one ends up correct', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet()));
    await Promise.all(
      wallets.flatMap((wallet) => [useCase.execute(command(wallet, Kind.Bet)), useCase.execute(command(wallet, Kind.Bet))]),
    );
    for (const wallet of wallets) await expectNoEffect(wallet, '50.00', 3, 2);
  }, CONCURRENCY_TIMEOUT);

  test('same key on different wallets: the lock does not serialize; the unique decides, no effect on the loser', async () => {
    const [a, b] = [await openWallet(), await openWallet()];
    const idempotencyKey = randomUUID();
    const results = await Promise.allSettled([
      useCase.execute(command(a, Kind.Bet, { idempotencyKey })),
      useCase.execute(command(b, Kind.Bet, { idempotencyKey })),
    ]);
    const conflicts = results.filter((r) => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect((conflicts[0] as PromiseRejectedResult).reason).toBeInstanceOf(IdempotencyConflictError);
    const debited = (await readWallet(a.id)).version === 2 ? [a, b] : [b, a];
    await expectNoEffect(debited[0]!, '75.00', 2, 1);
    await expectNoEffect(debited[1]!, '100.00', 1, 0);
    expect(await eventsOf(debited[1]!.id)).toHaveLength(0);
  }, CONCURRENCY_TIMEOUT);

  test('same key with different payloads on the same wallet: one wins, the other is a conflict', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet);
    const results = await Promise.allSettled([
      useCase.execute(bet),
      useCase.execute({ ...bet, money: { amount: '30.00', currency: 'BRL' } }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await movements(wallet.id)).toBe(1);
    await assertConsistent(wallet.id);
  }, CONCURRENCY_TIMEOUT);

  test('simultaneous REFUND and ROLLBACK of the same BET: only one reversal is applied', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet);
    await useCase.execute(bet);
    const reference = { referenceExternalTransactionId: bet.externalTransactionId };
    const results = await Promise.all([
      useCase.execute(command(wallet, Kind.Refund, reference)),
      useCase.execute(command(wallet, Kind.Rollback, reference)),
      useCase.execute(command(wallet, Kind.Refund, reference)),
    ]);
    expect(results.filter((r) => r.status === Status.Processed)).toHaveLength(1);
    expect(results.filter((r) => r.failureCode === 'ALREADY_REVERSED')).toHaveLength(2);
    await expectNoEffect(wallet, '100.00', 3, 2);
  }, CONCURRENCY_TIMEOUT);

  test('simultaneous reference and reversal: nothing is lost, and no order duplicates an effect', async () => {
    const wallet = await openWallet();
    const betId = randomUUID();
    const [refund, bet] = await Promise.all([
      useCase.execute(command(wallet, Kind.Refund, { referenceExternalTransactionId: betId })),
      useCase.execute(command(wallet, Kind.Bet, { externalTransactionId: betId })),
    ]);
    expect(bet.status).toBe(Status.Processed);
    expect([Status.Processed, Status.PendingReference]).toContain(refund.status);
    await assertConsistent(wallet.id);
  }, CONCURRENCY_TIMEOUT);

  test('two instances of the use case, sharing nothing but the database', async () => {
    const wallet = await openWallet();
    const other = buildUseCase(new MikroOrmUnitOfWork(db.orm, createPersistenceContext, 5000));
    const bet = command(wallet, Kind.Bet);
    const [a, b] = await Promise.all([useCase.execute(bet), other.execute(bet)]);
    expect([a.idempotentReplay, b.idempotentReplay].sort()).toEqual([false, true]);
    await expectNoEffect(wallet, '75.00', 2, 1);
  }, CONCURRENCY_TIMEOUT);
});

describe('atomicity and failure classification', () => {
  const fail = (message = 'injected failure') => { throw new Error(message); };

  test.each<[string, (real: WageringPersistence) => Partial<WageringPersistence>]>([
    ['when writing the wallet', (real) => ({ wallets: overriding(real.wallets, { update: async () => fail() }) })],
    ['when writing the ledger', (real) => ({ ledger: overriding(real.ledger, { append: async () => fail() }) })],
    ['after the first event', (real) => {
      let enqueued = 0;
      return {
        outbox: overriding(real.outbox, {
          enqueue: async (record) => {
            await real.outbox.enqueue(record);
            if (++enqueued === 1) fail();
          },
        }),
      };
    }],
  ])('failure %s undoes transaction, balance, ledger and events, and the resend applies once', async (_where, override) => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet);
    const failing = buildUseCase(uowWith(override));
    await expectError(failing.execute(bet), Error);

    await expectNoEffect(wallet, '100.00', 1, 0);
    expect(await uow.run((c) => c.transactions.findByIdempotencyKey(bet.idempotencyKey))).toBeUndefined();
    expect(await eventsOf(wallet.id)).toHaveLength(0);

    const retried = await useCase.execute(bet);
    expect(retried).toMatchObject({ status: Status.Processed, idempotentReplay: false });
    await expectNoEffect(wallet, '75.00', 2, 1);
    expect(await eventsOf(wallet.id)).toHaveLength(2);
  }, CONCURRENCY_TIMEOUT);

  test('real constraint violation: undoes everything and records an audited FAILED, without moving balance', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet);
    let firstAttempt = true;
    const failing = buildUseCase(
      uowWith((real) => ({
        ledger: overriding(real.ledger, {
          // O mesmo lançamento duas vezes: o PostgreSQL recusa de verdade, com SQLSTATE 23505.
          append: async (entry) => {
            await real.ledger.append(entry);
            if (firstAttempt) await real.ledger.append(entry);
            firstAttempt = false;
          },
        }),
      })),
    );
    const error = await expectError(failing.execute(bet), PersistenceConstraintError);
    expect(error.retryable).toBe(false);
    await expectNoEffect(wallet, '100.00', 1, 0);
    expect(await eventsOf(wallet.id)).toHaveLength(0);

    const failed = (await uow.run((c) => c.transactions.findByIdempotencyKey(bet.idempotencyKey)))!;
    expect(failed.status).toBe(Status.Failed);
    expect(failed.failureCode).toBe(FailureCode.InternalError);

    // FAILED é terminal: o reenvio é replay, e nunca aplica por cima.
    const replay = await useCase.execute(bet);
    expect(replay).toMatchObject({ status: Status.Failed, failureCode: 'INTERNAL_ERROR', idempotentReplay: true });
    expect(replay.balance).toBeUndefined();
    await expectNoEffect(wallet, '100.00', 1, 0);
  }, CONCURRENCY_TIMEOUT);

  test('a real transient error (lock timeout) does not become a rejection nor leave a trace; the resend applies', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet);
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const lockAcquired = new Promise<void>((resolve) => { locked = resolve; });
    const holder = uow.run(async (c) => {
      await c.wallets.findByIdForUpdate(wallet.id);
      locked();
      await released;
    });
    await lockAcquired;

    const impatient = buildUseCase(new MikroOrmUnitOfWork(db.orm, createPersistenceContext, 100));
    const error = await expectError(impatient.execute(bet), TransientInfrastructureError);
    expect(error.retryable).toBe(true);
    release();
    await holder;

    expect(await uow.run((c) => c.transactions.findByIdempotencyKey(bet.idempotencyKey))).toBeUndefined();
    await expectNoEffect(wallet, '100.00', 1, 0);
    expect(await useCase.execute(bet)).toMatchObject({ status: Status.Processed, idempotentReplay: false });
  }, CONCURRENCY_TIMEOUT);

  test('a transient error with the database available also records no terminal state', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet);
    const failing = buildUseCase(
      uowWith((real) => ({
        ledger: overriding(real.ledger, {
          append: async () => { throw new TransientInfrastructureError('connection lost'); },
        }),
      })),
    );
    await expectError(failing.execute(bet), TransientInfrastructureError);
    expect(await uow.run((c) => c.transactions.findByIdempotencyKey(bet.idempotencyKey))).toBeUndefined();
    await expectNoEffect(wallet, '100.00', 1, 0);
    expect(await useCase.execute(bet)).toMatchObject({ status: Status.Processed, idempotentReplay: false });
  });

  test('an unexpected failure is propagated without recording a terminal state', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet);
    const failing = buildUseCase(uowWith((real) => ({ outbox: overriding(real.outbox, { enqueue: async () => fail('defeito') }) })));
    const error = await expectError(failing.execute(bet), Error);
    expect(error.message).toBe('defeito');
    expect(await uow.run((c) => c.transactions.findByIdempotencyKey(bet.idempotencyKey))).toBeUndefined();
  });

  test('if recording FAILED also fails, the original error prevails', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet);
    let calls = 0;
    const flaky: UnitOfWork<WageringPersistence> = {
      run: async (work) => {
        if (++calls === 2) throw new TransientInfrastructureError('database down');
        return uow.run(() => { throw new PersistenceConstraintError('original'); }) as never;
      },
    };
    const error = await expectError(buildUseCase(flaky).execute(bet), PersistenceConstraintError);
    expect(error.constraint).toBe('original');
    expect(calls).toBe(2);
    await expectNoEffect(wallet, '100.00', 1, 0);
  });

  test('the version only changes with balance: the complete sequence keeps the invariant', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet);
    await useCase.execute(bet);
    await useCase.execute(command(wallet, Kind.Loss));
    await useCase.execute(command(wallet, Kind.Bet, { money: { amount: '1000.00', currency: 'BRL' } }));
    await useCase.execute(command(wallet, Kind.Refund, { referenceExternalTransactionId: 'nada' }));
    await useCase.execute(bet);
    expect((await readWallet(wallet.id)).version).toBe(2);
    await useCase.execute(command(wallet, Kind.Win));
    await useCase.execute(command(wallet, Kind.Refund, { referenceExternalTransactionId: bet.externalTransactionId }));
    await expectNoEffect(wallet, '125.00', 4, 3);
  });
});

describe('dependency injection', () => {
  test('Nest delivers the ready use case, bound to the configured database', async () => {
    @Module({ imports: [ConfigModule.register(testEnv({ DATABASE_URL: db.url })), PersistenceModule, WageringModule] })
    class TestModule {}
    const app = await NestFactory.createApplicationContext(TestModule, { logger: false });
    try {
      const wallet = await openWallet();
      const result = await app.get(ProcessWagerTransaction).execute(command(wallet, Kind.Bet));
      expect(result.status).toBe(Status.Processed);
      await assertConsistent(wallet.id);
    } finally {
      await app.close();
    }
  });
});
