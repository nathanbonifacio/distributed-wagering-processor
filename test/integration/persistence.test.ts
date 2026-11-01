import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import type { WageringPersistence } from '../../src/app/wagering/application/ports/wagering-persistence.port';
import { FailureCode } from '../../src/app/wagering/domain/failure-code';
import { WagerProcessor } from '../../src/app/wagering/domain/wager-processor';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/app/wagering/domain/wager-transaction.entity';
import { LedgerDirection, WalletLedgerEntry } from '../../src/app/wallet/domain/ledger-entry.entity';
import { Wallet } from '../../src/app/wallet/domain/wallet.entity';
import { InsufficientFundsError } from '../../src/app/wallet/domain/wallet-errors';
import { MikroOrmUnitOfWork } from '../../src/database/mikro-orm-unit-of-work';
import { createPersistenceContext, PERSISTENCE_SCHEMAS, PersistenceModule } from '../../src/persistence.module';
import {
  PersistenceConstraintError,
  TransientInfrastructureError,
} from '../../src/shared/application/infrastructure-error';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/shared/application/unit-of-work.port';
import { Money } from '../../src/shared/domain/money';
import { ConfigModule } from '../../src/shared/infrastructure/config.module';
import { testEnv, withHostPort } from '../support/env';
import { startBlackhole } from '../support/tcp-proxy';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

// Pré-requisito: `docker compose up -d postgres`. Banco PostgreSQL real e descartável; cada teste usa
// ids próprios, então não depende da ordem de execução.
const T0 = new Date('2026-10-31T12:00:00.123Z');
const T1 = new Date('2026-10-31T12:00:05.456Z');
const HASH = 'a'.repeat(64);

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

let db: TestDatabase;
let uow: UnitOfWork<WageringPersistence>;

beforeAll(async () => {
  db = await createTestDatabase({ entities: PERSISTENCE_SCHEMAS });
  await db.orm.migrator.up();
  uow = new MikroOrmUnitOfWork(db.orm, createPersistenceContext, 5000);
});
afterAll(async () => { await db.drop(); });

const newWallet = (amount = '100.00', playerId: string = randomUUID()) =>
  Wallet.open({ id: randomUUID(), playerId, initialBalance: brl(amount), at: T0 });

async function savedWallet(amount = '100.00'): Promise<Wallet> {
  const wallet = newWallet(amount);
  await uow.run((c) => c.wallets.insert(wallet));
  return wallet;
}

function newTx(wallet: Wallet, kind: Kind, overrides: Partial<CreateWagerTransactionProps> = {}) {
  const external = randomUUID();
  return WagerTransaction.create({
    id: randomUUID(),
    providerId: 'provider-a',
    externalTransactionId: external,
    idempotencyKey: `provider-a:${external}`,
    payloadHash: HASH,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl('25.00'),
    createdAt: T0,
    ...overrides,
  });
}

/** Transação já aplicada e gravada, para servir de referência. */
async function savedBet(wallet: Wallet, overrides: Partial<CreateWagerTransactionProps> = {}) {
  const bet = newTx(wallet, Kind.Bet, overrides);
  bet.recordObservedBalance(brl('75.00'));
  bet.markProcessed(undefined, T1);
  await uow.run((c) => c.transactions.insertIfAbsent(bet));
  return bet;
}

const read = (id: string) => uow.run((c) => c.transactions.findById(id));

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

/** Uma promessa resolvida de fora, para coordenar duas transações sem depender de tempo. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}

describe('schemas and database', () => {
  test('each EntitySchema maps exactly the columns of the table created by the migrations', async () => {
    const metadata = db.orm.getMetadata();
    const tables = new Set<string>();
    for (const meta of metadata.getAll().values()) {
      tables.add(meta.tableName);
      const mapped = Object.values(meta.properties).flatMap((property) => property.fieldNames).sort();
      const columns = await db.sql(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?`,
        [meta.tableName],
      );
      expect(mapped).toEqual(columns.map((c) => c.column_name).sort());
    }
    expect([...tables].sort()).toEqual(['inbox_messages', 'outbox_messages', 'wager_transactions', 'wallet_ledger_entries', 'wallets']);
  });
});

describe('Wallet', () => {
  test('round trip preserves id, player, currency, balance, version and dates', async () => {
    const wallet = await savedWallet('1000.50');
    const found = await uow.run((c) => c.wallets.findById(wallet.id));
    expect(found).toBeInstanceOf(Wallet);
    expect(found!.id).toBe(wallet.id);
    expect(found!.playerId).toBe(wallet.playerId);
    expect(found!.currency).toBe('BRL');
    expect(found!.balance.toJSON()).toEqual({ amount: '1000.50', currency: 'BRL' });
    expect(found!.version).toBe(1);
    expect(found!.createdAt).toEqual(T0);
    expect(found!.updatedAt).toEqual(T0);
  });

  test('lookup by player and currency', async () => {
    const wallet = await savedWallet();
    const found = await uow.run((c) => c.wallets.findByPlayerAndCurrency(wallet.playerId, 'BRL'));
    expect(found?.id).toBe(wallet.id);
    expect(await uow.run((c) => c.wallets.findByPlayerAndCurrency(wallet.playerId, 'USD'))).toBeUndefined();
  });

  test('nonexistent returns undefined', async () => {
    expect(await uow.run((c) => c.wallets.findById(randomUUID()))).toBeUndefined();
    expect(await uow.run((c) => c.wallets.findByIdForUpdate(randomUUID()))).toBeUndefined();
  });

  test('update writes the balance, version and date', async () => {
    const wallet = await savedWallet();
    wallet.debit({ entryId: randomUUID(), transactionId: randomUUID(), money: brl('30.10'), at: T1 });
    await uow.run((c) => c.wallets.update(wallet, 1));
    const found = await uow.run((c) => c.wallets.findById(wallet.id));
    expect(found!.balance.toJSON().amount).toBe('69.90');
    expect(found!.version).toBe(2);
    expect(found!.updatedAt).toEqual(T1);
    expect(found!.createdAt).toEqual(T0);
  });

  test('an update with a stale version fails as transient and changes nothing', async () => {
    const wallet = await savedWallet();
    wallet.credit({ entryId: randomUUID(), transactionId: randomUUID(), money: brl('1.00'), at: T1 });
    await expectError(uow.run((c) => c.wallets.update(wallet, 99)), TransientInfrastructureError);
    expect((await uow.run((c) => c.wallets.findById(wallet.id)))!.version).toBe(1);
  });

  test('the maximum Money value comes back exact', async () => {
    const wallet = await savedWallet('999999999999999999.99');
    expect((await uow.run((c) => c.wallets.findById(wallet.id)))!.balance.toJSON().amount).toBe('999999999999999999.99');
  });
});

describe('WagerTransaction', () => {
  test('round trip preserves every field of an applied transaction', async () => {
    const wallet = await savedWallet();
    const bet = await savedBet(wallet);
    const refund = newTx(wallet, Kind.Refund, {
      referenceExternalTransactionId: bet.externalTransactionId,
      money: brl('25.00'),
    });
    refund.recordObservedBalance(brl('100.00'));
    refund.markProcessed(bet.id, T1);
    expect(await uow.run((c) => c.transactions.insertIfAbsent(refund))).toBe(true);

    const found = await read(refund.id);
    expect(found).toBeInstanceOf(WagerTransaction);
    expect(found!.id).toBe(refund.id);
    expect(found!.providerId).toBe('provider-a');
    expect(found!.externalTransactionId).toBe(refund.externalTransactionId);
    expect(found!.idempotencyKey).toBe(refund.idempotencyKey);
    expect(found!.payloadHash).toBe(HASH);
    expect(found!.matchesPayload(HASH)).toBe(true);
    expect(found!.walletId).toBe(wallet.id);
    expect(found!.playerId).toBe(wallet.playerId);
    expect(found!.roundId).toBe('round-1');
    expect(found!.gameId).toBe('fortune-chimp');
    expect(found!.kind).toBe(Kind.Refund);
    expect(found!.money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(found!.referenceExternalTransactionId).toBe(bet.externalTransactionId);
    expect(found!.referenceTransactionId).toBe(bet.id);
    expect(found!.status).toBe(Status.Processed);
    expect(found!.failureCode).toBeUndefined();
    expect(found!.observedBalance?.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(found!.createdAt).toEqual(T0);
    expect(found!.processedAt).toEqual(T1);
  });

  test('rebuilding does not trigger a transition: terminal stays terminal and accepts no change', async () => {
    const wallet = await savedWallet();
    const rejected = newTx(wallet, Kind.Bet);
    rejected.recordObservedBalance(brl('100.00'));
    rejected.reject(FailureCode.InsufficientFunds, T1);
    await uow.run((c) => c.transactions.insertIfAbsent(rejected));

    const found = await read(rejected.id);
    expect(found!.status).toBe(Status.Rejected);
    expect(found!.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(found!.isTerminal()).toBe(true);
    expect(found!.processedAt).toEqual(T1);
    expect(() => found!.markProcessed(undefined, T1)).toThrow();
  });

  test('PENDING_REFERENCE: no observed balance; schedule preserved; resumption writes the decision', async () => {
    const wallet = await savedWallet();
    const bet = await savedBet(wallet);
    const refund = newTx(wallet, Kind.Refund, { referenceExternalTransactionId: bet.externalTransactionId });
    refund.markPendingReference();
    refund.scheduleReferenceRetry(T0);
    await uow.run((c) => c.transactions.insertIfAbsent(refund));

    const pending = await read(refund.id);
    expect(pending!.status).toBe(Status.PendingReference);
    expect(pending!.observedBalance).toBeUndefined();
    expect(pending!.processedAt).toBeUndefined();
    expect(pending!.attempts).toBe(0);
    expect(pending!.nextAttemptAt).toEqual(T0);

    pending!.scheduleReferenceRetry(T1);
    await uow.run((c) => c.transactions.update(pending!));
    const rescheduled = await read(refund.id);
    expect(rescheduled!.attempts).toBe(1);
    expect(rescheduled!.nextAttemptAt).toEqual(T1);

    rescheduled!.recordObservedBalance(brl('100.00'));
    rescheduled!.markProcessed(bet.id, T1);
    await uow.run((c) => c.transactions.update(rescheduled!));
    const decided = await read(refund.id);
    expect(decided!.status).toBe(Status.Processed);
    expect(decided!.referenceTransactionId).toBe(bet.id);
    expect(decided!.nextAttemptAt).toBeUndefined();
    expect(decided!.attempts).toBe(1);
  });

  test('the observed balance comes back in the wallet currency, even if the operation is in another currency', async () => {
    const wallet = await savedWallet();
    const mismatch = newTx(wallet, Kind.Bet, { money: usd('5.00') });
    const outcome = new WagerProcessor().process({ wallet, transaction: mismatch, ledgerEntryId: randomUUID(), at: T1 });
    expect(outcome.outcome).toBe('REJECTED');
    await uow.run((c) => c.transactions.insertIfAbsent(mismatch));

    const found = await read(mismatch.id);
    expect(found!.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(found!.money.currency).toBe('USD');
    expect(found!.observedBalance?.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
  });

  test('lookup by external id respects the provider', async () => {
    const wallet = await savedWallet();
    const bet = await savedBet(wallet);
    const found = await uow.run((c) => c.transactions.findByExternalId('provider-a', bet.externalTransactionId));
    expect(found?.id).toBe(bet.id);
    expect(await uow.run((c) => c.transactions.findByExternalId('provider-b', bet.externalTransactionId))).toBeUndefined();
  });

  test('lookup by idempotency key', async () => {
    const bet = await savedBet(await savedWallet());
    expect((await uow.run((c) => c.transactions.findByIdempotencyKey(bet.idempotencyKey)))?.id).toBe(bet.id);
    expect(await uow.run((c) => c.transactions.findByIdempotencyKey('outra'))).toBeUndefined();
  });

  test('applied reversal: finds a REFUND, ignores a rejected one and a WIN', async () => {
    const wallet = await savedWallet();
    const bet = await savedBet(wallet);
    const reference = { referenceExternalTransactionId: bet.externalTransactionId };

    const win = newTx(wallet, Kind.Win, reference);
    win.recordObservedBalance(brl('1.00'));
    win.markProcessed(bet.id, T1);
    const rejected = newTx(wallet, Kind.Refund, reference);
    rejected.recordObservedBalance(brl('1.00'));
    rejected.reject(FailureCode.AmountMismatch, T1);
    await uow.run(async (c) => {
      await c.transactions.insertIfAbsent(win);
      await c.transactions.insertIfAbsent(rejected);
    });
    // Rejeitada com a referência já resolvida: o schema permite, e ela não conta como reversão aplicada.
    await db.sql(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status, failure_code,
         observed_balance, observed_balance_currency, created_at, processed_at)
       VALUES (?, 'provider-a', ?, ?, ?, ?, ?, 'round-1', 'g', 'REFUND', '25.00', 'BRL', ?, ?, 'REJECTED', 'AMOUNT_MISMATCH', '1.00', 'BRL', ?, ?)`,
      [randomUUID(), randomUUID(), randomUUID(), HASH, wallet.id, wallet.playerId, bet.externalTransactionId, bet.id, T1, T1],
    );
    expect(await uow.run((c) => c.transactions.findAppliedReversal(bet.id))).toBeUndefined();

    const refund = newTx(wallet, Kind.Refund, reference);
    refund.recordObservedBalance(brl('1.00'));
    refund.markProcessed(bet.id, T1);
    await uow.run((c) => c.transactions.insertIfAbsent(refund));
    expect((await uow.run((c) => c.transactions.findAppliedReversal(bet.id)))?.id).toBe(refund.id);
  });

  test('due pending ones: only those past their deadline, from oldest to newest', async () => {
    const wallet = await savedWallet();
    const make = async (at: Date) => {
      const tx = newTx(wallet, Kind.Refund, { referenceExternalTransactionId: 'ausente' });
      tx.markPendingReference();
      tx.scheduleReferenceRetry(at);
      await uow.run((c) => c.transactions.insertIfAbsent(tx));
      return tx.id;
    };
    const late = await make(new Date('2000-01-02T00:00:00Z'));
    const early = await make(new Date('2000-01-01T00:00:00Z'));
    const future = await make(new Date('2999-01-01T00:00:00Z'));

    const due = await uow.run((c) => c.transactions.findDuePendingIds(new Date('2001-01-01T00:00:00Z'), 1000));
    expect(due.indexOf(early)).toBeGreaterThanOrEqual(0);
    expect(due.indexOf(early)).toBeLessThan(due.indexOf(late));
    expect(due).not.toContain(future);
    expect((await uow.run((c) => c.transactions.findDuePendingIds(new Date('2001-01-01T00:00:00Z'), 1)))).toHaveLength(1);
  });

  test('insertIfAbsent: a repeated key returns false and the SQL transaction stays usable', async () => {
    const wallet = await savedWallet();
    const first = await savedBet(wallet);
    const duplicate = newTx(wallet, Kind.Bet, { idempotencyKey: first.idempotencyKey });
    duplicate.recordObservedBalance(brl('1.00'));
    duplicate.markProcessed(undefined, T1);

    const after = newWallet();
    const inserted = await uow.run(async (c) => {
      const result = await c.transactions.insertIfAbsent(duplicate);
      await c.wallets.insert(after); // sem ON CONFLICT, isto falharia: a transação estaria abortada
      return result;
    });
    expect(inserted).toBe(false);
    expect(await read(duplicate.id)).toBeUndefined();
    expect((await uow.run((c) => c.wallets.findById(after.id)))?.id).toBe(after.id);
  });

  test('a second applied reversal is not included, even of another kind', async () => {
    const wallet = await savedWallet();
    const bet = await savedBet(wallet);
    const reversal = (kind: Kind) => {
      const tx = newTx(wallet, kind, { referenceExternalTransactionId: bet.externalTransactionId });
      tx.recordObservedBalance(brl('1.00'));
      tx.markProcessed(bet.id, T1);
      return tx;
    };
    expect(await uow.run((c) => c.transactions.insertIfAbsent(reversal(Kind.Refund)))).toBe(true);
    expect(await uow.run((c) => c.transactions.insertIfAbsent(reversal(Kind.Rollback)))).toBe(false);
  });

  test('updating a terminal transaction is refused by the database', async () => {
    const bet = await savedBet(await savedWallet());
    const error = await expectError(uow.run((c) => c.transactions.update(bet)), PersistenceConstraintError);
    expect(error.retryable).toBe(false);
  });
});

describe('WalletLedgerEntry', () => {
  async function savedEntry() {
    const wallet = await savedWallet();
    const bet = await savedBet(wallet);
    const entry = wallet.debit({ entryId: randomUUID(), transactionId: bet.id, money: brl('25.10'), at: T1 });
    await uow.run((c) => c.ledger.append(entry));
    return { wallet, bet, entry };
  }

  test('round trip preserves every field and stays balanced', async () => {
    const { wallet, bet, entry } = await savedEntry();
    const { entries } = await uow.run((c) => c.ledger.listByWallet(wallet.id, { limit: 10 }));
    expect(entries).toHaveLength(1);
    const found = entries[0]!;
    expect(found).toBeInstanceOf(WalletLedgerEntry);
    expect(found.id).toBe(entry.id);
    expect(found.walletId).toBe(wallet.id);
    expect(found.transactionId).toBe(bet.id);
    expect(found.walletVersion).toBe(2);
    expect(found.direction).toBe(LedgerDirection.Debit);
    expect(found.money.toJSON()).toEqual({ amount: '25.10', currency: 'BRL' });
    expect(found.balanceBefore.toJSON().amount).toBe('100.00');
    expect(found.balanceAfter.toJSON().amount).toBe('74.90');
    expect(found.createdAt).toEqual(T1);
    expect(found.isBalanced()).toBe(true);
  });

  test('pagination by seq neither repeats nor skips, and totals rebuild the balance', async () => {
    const wallet = newWallet('10.00');
    const opening = WagerTransaction.createOpening({
      id: randomUUID(), payloadHash: HASH, walletId: wallet.id, playerId: wallet.playerId, money: brl('10.00'), createdAt: T0,
    });
    const processor = new WagerProcessor();
    const ids: string[] = [];
    await uow.run(async (c) => {
      await c.wallets.insert(wallet);
      const { ledgerEntry } = processor.processOpening({ wallet, transaction: opening, ledgerEntryId: randomUUID(), at: T0 });
      await c.transactions.insertIfAbsent(opening);
      await c.ledger.append(ledgerEntry!);
      ids.push(ledgerEntry!.id);
      for (const amount of ['1.10', '2.20', '3.30']) {
        const previous = wallet.version;
        const tx = newTx(wallet, Kind.Win, { money: brl(amount) });
        const outcome = processor.process({ wallet, transaction: tx, ledgerEntryId: randomUUID(), at: T1 });
        if (outcome.outcome !== 'APPLIED') throw new Error('esperava aplicar');
        await c.transactions.insertIfAbsent(tx);
        await c.ledger.append(outcome.ledgerEntry!);
        await c.wallets.update(wallet, previous);
        ids.push(outcome.ledgerEntry!.id);
      }
    });

    const first = await uow.run((c) => c.ledger.listByWallet(wallet.id, { limit: 2 }));
    const second = await uow.run((c) => c.ledger.listByWallet(wallet.id, { afterSeq: first.lastSeq, limit: 2 }));
    const third = await uow.run((c) => c.ledger.listByWallet(wallet.id, { afterSeq: second.lastSeq, limit: 2 }));
    expect([...first.entries, ...second.entries].map((e) => e.id)).toEqual(ids);
    expect(third.entries).toEqual([]);
    expect(typeof first.lastSeq).toBe('string');

    const totals = await uow.run((c) => c.ledger.totals(wallet.id, 'BRL'));
    expect(totals.signedTotal.toJSON().amount).toBe('16.60');
    expect(totals.entryCount).toBe(4);
    expect(totals.signedTotal.equals((await uow.run((c) => c.wallets.findById(wallet.id)))!.balance)).toBe(true);
  });

  test('totals: a wallet without entries gives zero; debits only give a negative, keeping the sign', async () => {
    const empty = await savedWallet('0.00');
    expect(await uow.run((c) => c.ledger.totals(empty.id, 'BRL'))).toMatchObject({ entryCount: 0 });
    expect((await uow.run((c) => c.ledger.totals(empty.id, 'BRL'))).signedTotal.isZero()).toBe(true);

    const { wallet } = await savedEntry();
    const { signedTotal } = await uow.run((c) => c.ledger.totals(wallet.id, 'BRL'));
    expect(signedTotal.isNegative()).toBe(true);
    expect(signedTotal.toJSON().amount).toBe('-25.10');
  });

  test('the database refuses to change a stored entry', async () => {
    const { entry } = await savedEntry();
    await expect(db.sql('UPDATE wallet_ledger_entries SET amount = 1 WHERE id = ?', [entry.id])).rejects.toThrow('imutável');
  });
});

describe('unit of work', () => {
  test('commit: everything is written together', async () => {
    const wallet = newWallet();
    const tx = newTx(wallet, Kind.Bet);
    tx.recordObservedBalance(brl('75.00'));
    tx.markProcessed(undefined, T1);
    const entry = wallet.debit({ entryId: randomUUID(), transactionId: tx.id, money: brl('25.00'), at: T1 });
    const eventId = randomUUID();

    await uow.run(async (c) => {
      await c.wallets.insert(wallet);
      await c.transactions.insertIfAbsent(tx);
      await c.ledger.append(entry);
      await c.outbox.enqueue({ id: eventId, aggregateId: wallet.id, eventType: 'E', payload: { a: 1 }, occurredAt: T1, nextAttemptAt: T1 });
    });

    expect(await uow.run((c) => c.wallets.findById(wallet.id))).toBeDefined();
    expect(await read(tx.id)).toBeDefined();
    expect((await uow.run((c) => c.ledger.totals(wallet.id, 'BRL'))).entryCount).toBe(1);
    expect(await db.sql('SELECT id FROM outbox_messages WHERE id = ?', [eventId])).toHaveLength(1);
  });

  test('rollback: a failure at the end undoes wallet, transaction, ledger, inbox and outbox', async () => {
    const wallet = newWallet();
    const tx = newTx(wallet, Kind.Bet);
    tx.recordObservedBalance(brl('75.00'));
    tx.markProcessed(undefined, T1);
    const entry = wallet.debit({ entryId: randomUUID(), transactionId: tx.id, money: brl('25.00'), at: T1 });
    const [eventId, messageId] = [randomUUID(), randomUUID()];

    await expect(uow.run(async (c) => {
      await c.wallets.insert(wallet);
      await c.transactions.insertIfAbsent(tx);
      await c.ledger.append(entry);
      await c.inbox.recordIfNew({ consumerName: 'c', messageId, payloadHash: HASH, receivedAt: T1 });
      await c.outbox.enqueue({ id: eventId, aggregateId: wallet.id, eventType: 'E', payload: {}, occurredAt: T1, nextAttemptAt: T1 });
      throw new Error('injected failure');
    })).rejects.toThrow('injected failure');

    expect(await uow.run((c) => c.wallets.findById(wallet.id))).toBeUndefined();
    expect(await read(tx.id)).toBeUndefined();
    expect(await db.sql('SELECT id FROM wallet_ledger_entries WHERE id = ?', [entry.id])).toHaveLength(0);
    expect(await uow.run((c) => c.inbox.find('c', messageId))).toBeUndefined();
    expect(await db.sql('SELECT id FROM outbox_messages WHERE id = ?', [eventId])).toHaveLength(0);
  });

  test('shared context: what was written is visible inside the transaction and invisible outside until the commit', async () => {
    const wallet = newWallet();
    const written = gate();
    const checked = gate();
    const running = uow.run(async (c) => {
      await c.wallets.insert(wallet);
      expect((await c.wallets.findById(wallet.id))?.id).toBe(wallet.id);
      written.open();
      await checked.opened;
    });
    await written.opened;
    expect(await uow.run((c) => c.wallets.findById(wallet.id))).toBeUndefined();
    checked.open();
    await running;
    expect((await uow.run((c) => c.wallets.findById(wallet.id)))?.id).toBe(wallet.id);
  });

  test('a domain error passes through intact and rolls the transaction back', async () => {
    const wallet = newWallet('1.00');
    await expectError(uow.run(async (c) => {
      await c.wallets.insert(wallet);
      wallet.debit({ entryId: randomUUID(), transactionId: randomUUID(), money: brl('5.00'), at: T1 });
    }), InsufficientFundsError);
    expect(await uow.run((c) => c.wallets.findById(wallet.id))).toBeUndefined();
  });

  test('each run gets its own repositories', async () => {
    const seen: WageringPersistence[] = [];
    await uow.run(async (c) => { seen.push(c); });
    await uow.run(async (c) => { seen.push(c); });
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0]!.wallets).not.toBe(seen[1]!.wallets);
  });
});

describe('pessimistic lock per wallet', () => {
  test('the second transaction waits for the lock and reads the already committed balance', async () => {
    const wallet = await savedWallet('100.00');
    const release = gate();
    const locked = gate();

    const first = uow.run(async (c) => {
      const w = (await c.wallets.findByIdForUpdate(wallet.id))!;
      locked.open();
      await release.opened;
      w.debit({ entryId: randomUUID(), transactionId: randomUUID(), money: brl('80.00'), at: T1 });
      await c.wallets.update(w, 1);
    });
    await locked.opened;

    let secondBalance: string | undefined;
    const second = uow.run(async (c) => {
      const w = (await c.wallets.findByIdForUpdate(wallet.id))!;
      secondBalance = w.balance.toJSON().amount;
    });
    await waitForBlockedSession();
    expect(secondBalance).toBeUndefined(); // bloqueada de fato, ainda sem ler

    release.open();
    await Promise.all([first, second]);
    expect(secondBalance).toBe('20.00');
  });

  test('an earlier read in the same transaction does not let a stale balance decide (no Identity Map)', async () => {
    const wallet = await savedWallet('100.00');
    const firstRead = gate();
    const committed = gate();

    const reader = uow.run(async (c) => {
      const stale = (await c.wallets.findById(wallet.id))!;
      expect(stale.balance.toJSON().amount).toBe('100.00');
      firstRead.open();
      await committed.opened;
      return (await c.wallets.findByIdForUpdate(wallet.id))!.balance.toJSON().amount;
    });

    await firstRead.opened;
    await uow.run(async (c) => {
      const w = (await c.wallets.findByIdForUpdate(wallet.id))!;
      w.debit({ entryId: randomUUID(), transactionId: randomUUID(), money: brl('60.00'), at: T1 });
      await c.wallets.update(w, 1);
    });
    committed.open();
    expect(await reader).toBe('40.00');
  });

  test('the transaction can also be locked: the second read waits and sees the recorded decision', async () => {
    const wallet = await savedWallet();
    const pending = newTx(wallet, Kind.Refund, { referenceExternalTransactionId: 'ausente' });
    pending.markPendingReference();
    pending.scheduleReferenceRetry(T0);
    await uow.run((c) => c.transactions.insertIfAbsent(pending));

    const release = gate();
    const locked = gate();
    const first = uow.run(async (c) => {
      const tx = (await c.transactions.findByIdForUpdate(pending.id))!;
      locked.open();
      await release.opened;
      tx.recordObservedBalance(brl('100.00'));
      tx.reject(FailureCode.ReferenceNotFound, T1);
      await c.transactions.update(tx);
    });
    await locked.opened;

    let seen: Status | undefined;
    const second = uow.run(async (c) => {
      seen = (await c.transactions.findByIdForUpdate(pending.id))!.status;
    });
    await waitForBlockedSession();
    expect(seen).toBeUndefined();

    release.open();
    await Promise.all([first, second]);
    expect(seen).toBe(Status.Rejected);
    expect(await uow.run((c) => c.transactions.findByIdForUpdate(randomUUID()))).toBeUndefined();
  });

  test('different wallets do not block each other (no global lock)', async () => {
    const [a, b] = [await savedWallet(), await savedWallet()];
    const release = gate();
    const locked = gate();
    const holder = uow.run(async (c) => {
      await c.wallets.findByIdForUpdate(a.id);
      locked.open();
      await release.opened;
    });
    await locked.opened;
    // Conclui enquanto a outra wallet segue travada; se bloqueasse, o teste estouraria o tempo.
    const other = await uow.run(async (c) => (await c.wallets.findByIdForUpdate(b.id))!.id);
    expect(other).toBe(b.id);
    release.open();
    await holder;
  });

  test('lock_timeout becomes a transient failure, without exposing SQL', async () => {
    const wallet = await savedWallet();
    const impatient = new MikroOrmUnitOfWork(db.orm, createPersistenceContext, 100);
    const release = gate();
    const locked = gate();
    const holder = uow.run(async (c) => {
      await c.wallets.findByIdForUpdate(wallet.id);
      locked.open();
      await release.opened;
    });
    await locked.opened;

    const error = await expectError(impatient.run((c) => c.wallets.findByIdForUpdate(wallet.id)), TransientInfrastructureError);
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain('select');
    expect(error.message).not.toContain(wallet.id);
    release.open();
    await holder;
  });

  test('a deadlock becomes a transient failure, and the other transaction completes', async () => {
    const [a, b] = [await savedWallet(), await savedWallet()];
    const bothLocked = { first: gate(), second: gate() };
    const cross = (mine: Wallet, other: Wallet, signal: { open: () => void }, wait: Promise<void>) =>
      uow.run(async (c) => {
        await c.wallets.findByIdForUpdate(mine.id);
        signal.open();
        await wait;
        await c.wallets.findByIdForUpdate(other.id);
      });

    const results = await Promise.allSettled([
      cross(a, b, bothLocked.first, bothLocked.second.opened),
      cross(b, a, bothLocked.second, bothLocked.first.opened),
    ]);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(TransientInfrastructureError);
  });

  test('100 / 80 / 80 with truly simultaneous transactions: one debit, one correct final balance', async () => {
    const wallet = await savedWallet('100.00');
    const processor = new WagerProcessor();
    const bet = (external: string) =>
      uow.run(async (c) => {
        const locked = (await c.wallets.findByIdForUpdate(wallet.id))!;
        const previous = locked.version;
        const tx = newTx(locked, Kind.Bet, { externalTransactionId: external, idempotencyKey: external, money: brl('80.00') });
        const outcome = processor.process({ wallet: locked, transaction: tx, ledgerEntryId: randomUUID(), at: T1 });
        await c.transactions.insertIfAbsent(tx);
        if (outcome.outcome === 'APPLIED') {
          await c.ledger.append(outcome.ledgerEntry!);
          await c.wallets.update(locked, previous);
        }
        return tx.status;
      });

    const statuses = await Promise.all([bet(randomUUID()), bet(randomUUID())]);
    expect(statuses.sort()).toEqual([Status.Processed, Status.Rejected]);
    const final = (await uow.run((c) => c.wallets.findById(wallet.id)))!;
    expect(final.balance.toJSON().amount).toBe('20.00');
    expect(final.version).toBe(2);
    expect((await uow.run((c) => c.ledger.totals(wallet.id, 'BRL'))).entryCount).toBe(1);
  });

  test('20 simultaneous debits on the same wallet: no lost update', async () => {
    const wallet = await savedWallet('20.00');
    await Promise.all(Array.from({ length: 20 }, () =>
      uow.run(async (c) => {
        const locked = (await c.wallets.findByIdForUpdate(wallet.id))!;
        const previous = locked.version;
        locked.debit({ entryId: randomUUID(), transactionId: randomUUID(), money: brl('1.00'), at: T1 });
        await c.wallets.update(locked, previous);
      }),
    ));
    const final = (await uow.run((c) => c.wallets.findById(wallet.id)))!;
    expect(final.balance.isZero()).toBe(true);
    expect(final.version).toBe(21);
  });
});

describe('error translation', () => {
  test('duplicate wallet: constraint identified, no SQL or values in the message', async () => {
    const wallet = await savedWallet();
    const duplicate = newWallet('5.00', wallet.playerId);
    const error = await expectError(uow.run((c) => c.wallets.insert(duplicate)), PersistenceConstraintError);
    expect(error.constraint).toBe('wallets_player_currency_unique');
    expect(error.retryable).toBe(false);
    expect(error.message).not.toContain('insert');
    expect(error.message).not.toContain(wallet.playerId);
    expect(error.cause).toBeDefined();
  });

  test('CHECK: negative balance written from outside the domain', async () => {
    const wallet = Wallet.rehydrate({
      id: randomUUID(), playerId: randomUUID(), currency: 'BRL', balance: brl('1.00').negate(), version: 1, createdAt: T0, updatedAt: T0,
    });
    const error = await expectError(uow.run((c) => c.wallets.insert(wallet)), PersistenceConstraintError);
    expect(error.constraint).toBe('wallets_balance_non_negative');
  });

  test('FK: ledger entry of a nonexistent transaction', async () => {
    const wallet = await savedWallet();
    const entry = wallet.debit({ entryId: randomUUID(), transactionId: randomUUID(), money: brl('1.00'), at: T1 });
    const error = await expectError(uow.run((c) => c.ledger.append(entry)), PersistenceConstraintError);
    expect(error.constraint).toBe('ledger_transaction_same_wallet');
  });

  test('trigger: ledger entry of a LOSS', async () => {
    const wallet = await savedWallet();
    const loss = newTx(wallet, Kind.Loss);
    loss.recordObservedBalance(brl('100.00'));
    loss.markProcessed(undefined, T1);
    await uow.run((c) => c.transactions.insertIfAbsent(loss));
    const entry = wallet.debit({ entryId: randomUUID(), transactionId: loss.id, money: brl('1.00'), at: T1 });
    await expectError(uow.run((c) => c.ledger.append(entry)), PersistenceConstraintError);
  });

  test('an unreachable database becomes a transient failure, without exposing the URL', async () => {
    const url = withHostPort(db.url, '127.0.0.1', 1);
    const orm = new MikroORM({ clientUrl: url, entities: PERSISTENCE_SCHEMAS, discovery: { warnWhenNoEntities: false } });
    const down = new MikroOrmUnitOfWork(orm, createPersistenceContext, 100);
    const error = await expectError(down.run((c) => c.wallets.findById(randomUUID())), TransientInfrastructureError);
    expect(error.message).not.toContain('postgres://');
    expect(error.message).not.toContain('127.0.0.1');
    await orm.close(true);
  });

  test('a database that accepts the connection and does not respond becomes a transient failure within the driver deadline', async () => {
    const hole = await startBlackhole();
    const orm = new MikroORM({
      clientUrl: withHostPort(db.url, '127.0.0.1', hole.port),
      entities: PERSISTENCE_SCHEMAS,
      discovery: { warnWhenNoEntities: false },
      driverOptions: { connectionTimeoutMillis: 200 },
    });
    const hung = new MikroOrmUnitOfWork(orm, createPersistenceContext, 100);
    await expectError(hung.run((c) => c.wallets.findById(randomUUID())), TransientInfrastructureError);
    await hole.close();
    await orm.close(true);
  });

  test('an unexpected error passes through untranslated', async () => {
    const defect = new TypeError('programming defect');
    const error = await expectError(uow.run(async () => { throw defect; }), TypeError);
    expect(error).toBe(defect);
  });

  test('invalid SQL is not disguised as a transient failure', async () => {
    let caught: unknown;
    try {
      await uow.run(() => db.orm.em.fork().getConnection().execute('SELEC 1'));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(caught).not.toBeInstanceOf(TransientInfrastructureError);
    expect(caught).not.toBeInstanceOf(PersistenceConstraintError);
  });
});

describe('inbox and outbox', () => {
  const record = () => ({ consumerName: 'wager-consumer', messageId: randomUUID(), payloadHash: HASH, receivedAt: T0 });

  test('inbox: a new one is accepted, a duplicate does not abort the transaction, and the hash allows comparison', async () => {
    const message = record();
    const results = await uow.run(async (c) => {
      const first = await c.inbox.recordIfNew(message);
      const second = await c.inbox.recordIfNew({ ...message, payloadHash: 'b'.repeat(64) });
      return [first, second, await c.inbox.find(message.consumerName, message.messageId)] as const;
    });
    expect(results[0]).toBe(true);
    expect(results[1]).toBe(false);
    expect(results[2]?.payloadHash).toBe(HASH);
    expect(results[2]?.processedAt).toBeUndefined();
  });

  test('inbox: the same message for another consumer is allowed; markProcessed writes the date', async () => {
    const message = record();
    await uow.run(async (c) => {
      await c.inbox.recordIfNew(message);
      expect(await c.inbox.recordIfNew({ ...message, consumerName: 'outro' })).toBe(true);
      await c.inbox.markProcessed(message.consumerName, message.messageId, T1);
    });
    const found = await uow.run((c) => c.inbox.find(message.consumerName, message.messageId));
    expect(found?.processedAt).toEqual(T1);
    expect((await uow.run((c) => c.inbox.find('outro', message.messageId)))?.processedAt).toBeUndefined();
  });

  test('outbox: the envelope is stored intact, pending, and with the money as a string', async () => {
    const id = randomUUID();
    const payload = { eventId: id, data: { money: { amount: '25.00', currency: 'BRL' } } };
    await uow.run((c) => c.outbox.enqueue({ id, aggregateId: randomUUID(), eventType: 'WalletBalanceChanged', payload, occurredAt: T0, nextAttemptAt: T1 }));
    const [row] = await db.sql('SELECT payload, attempts, published_at, next_attempt_at FROM outbox_messages WHERE id = ?', [id]);
    expect(row?.payload).toEqual(payload);
    expect(row?.attempts).toBe(0);
    expect(row?.published_at).toBeNull();
    expect(new Date(row?.next_attempt_at)).toEqual(T1);
  });
});

describe('dependency injection', () => {
  test('Nest delivers the UNIT_OF_WORK by token, bound to the configured database', async () => {
    @Module({ imports: [ConfigModule.register(testEnv({ DATABASE_URL: db.url })), PersistenceModule] })
    class TestModule {}
    const app = await NestFactory.createApplicationContext(TestModule, { logger: false });
    try {
      const injected = app.get<UnitOfWork<WageringPersistence>>(UNIT_OF_WORK);
      const wallet = newWallet();
      await injected.run((c) => c.wallets.insert(wallet));
      expect((await uow.run((c) => c.wallets.findById(wallet.id)))?.id).toBe(wallet.id);
    } finally {
      await app.close();
    }
  });
});
