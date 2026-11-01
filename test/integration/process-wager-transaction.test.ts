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
  throw new Error('nenhuma sessão ficou bloqueada no prazo');
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

describe('operações', () => {
  test('BET aplicada: debita, lança, versiona e registra os eventos', async () => {
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

  test('BET sem saldo: REJECTED, auditável, sem lançamento nem versão', async () => {
    const wallet = await openWallet('10.00');
    const result = await useCase.execute(command(wallet, Kind.Bet));
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: 'INSUFFICIENT_FUNDS', idempotentReplay: false });
    expect(moneyOf(result)).toBe('10.00');
    await expectNoEffect(wallet, '10.00', 1, 0);
    expect((await readTx(result.transactionId)).status).toBe(Status.Rejected);
    expect(await eventTypes(wallet.id)).toEqual(['WagerTransactionRejected']);
  });

  test('BET de todo o saldo chega a zero, sem negativo', async () => {
    const wallet = await openWallet('25.00');
    expect(moneyOf(await useCase.execute(command(wallet, Kind.Bet)))).toBe('0.00');
    await expectNoEffect(wallet, '0.00', 2, 1);
  });

  test('WIN credita, com ou sem referência, e o valor é livre', async () => {
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

  test('LOSS registra sem mover saldo: sem lançamento, sem versão, só o evento Processed', async () => {
    const wallet = await openWallet();
    const result = await useCase.execute(command(wallet, Kind.Loss));
    expect(result.status).toBe(Status.Processed);
    expect(moneyOf(result)).toBe('100.00');
    await expectNoEffect(wallet, '100.00', 1, 0);
    expect(await eventTypes(wallet.id)).toEqual(['WagerTransactionProcessed']);
  });

  test('LOSS aceita valor zero', async () => {
    const wallet = await openWallet();
    const result = await useCase.execute(command(wallet, Kind.Loss, { money: { amount: '0.00', currency: 'BRL' } }));
    expect(result.status).toBe(Status.Processed);
  });

  test('REFUND válido devolve o valor da BET', async () => {
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

  test('ROLLBACK válido aplica o inverso da referência: BET credita, WIN e REFUND debitam', async () => {
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

  test('wallet de outro player: REJECTED, com o saldo observado', async () => {
    const wallet = await openWallet();
    const result = await useCase.execute(command(wallet, Kind.Bet, { playerId: randomUUID() }));
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: 'PLAYER_WALLET_MISMATCH' });
    await expectNoEffect(wallet, '100.00', 1, 0);
  });

  test('moeda diferente: REJECTED, e o saldo observado continua na moeda da wallet', async () => {
    const wallet = await openWallet();
    const result = await useCase.execute(command(wallet, Kind.Bet, { money: { amount: '25.00', currency: 'USD' } }));
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: 'CURRENCY_MISMATCH' });
    expect(result.balance?.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect((await readTx(result.transactionId)).observedBalance?.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    await expectNoEffect(wallet, '100.00', 1, 0);
  });

  test('crédito além do limite do NUMERIC(20,2): REJECTED, sem efeito', async () => {
    const wallet = await openWallet('999999999999999999.99');
    const result = await useCase.execute(command(wallet, Kind.Win, { money: { amount: '0.01', currency: 'BRL' } }));
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: 'BALANCE_LIMIT_EXCEEDED' });
    await expectNoEffect(wallet, '999999999999999999.99', 1, 0);
  });

  test('valores nos limites passam sem perda de precisão', async () => {
    const wallet = await openWallet('999999999999999999.99');
    const result = await useCase.execute(command(wallet, Kind.Bet, { money: { amount: '0.01', currency: 'BRL' } }));
    expect(moneyOf(result)).toBe('999999999999999999.98');
    await assertConsistent(wallet.id);
  });
});

describe('validação de entrada', () => {
  test('OPENING nunca é aceita como operação externa, e nada é gravado', async () => {
    const wallet = await openWallet();
    const external = command(wallet, Kind.Opening);
    await expectError(useCase.execute(external), InvalidWagerTransactionError);
    expect(await uow.run((c) => c.transactions.findByIdempotencyKey(external.idempotencyKey))).toBeUndefined();
  });

  test('o provider reservado é recusado na entrada', async () => {
    const wallet = await openWallet();
    await expectError(useCase.execute(command(wallet, Kind.Bet, { providerId: INTERNAL_PROVIDER_ID })), InvalidWagerTransactionError);
  });

  test('não se reutiliza a identidade determinística da OPENING', async () => {
    const wallet = await openWallet();
    const opening = `opening:${wallet.id}`;
    await expectError(
      useCase.execute(command(wallet, Kind.Bet, { idempotencyKey: opening })),
      IdempotencyConflictError,
    );
    await expectNoEffect(wallet, '100.00', 1, 0);
  });

  test.each([['25'], ['25.5'], ['25.555'], ['-25.00'], ['1e2'], ['']])('valor fora do contrato é recusado: "%s"', async (amount) => {
    const wallet = await openWallet();
    await expectError(useCase.execute(command(wallet, Kind.Bet, { money: { amount, currency: 'BRL' } })), InvalidMoneyError);
    await expectNoEffect(wallet, '100.00', 1, 0);
  });

  test('zero é recusado em quem move saldo; REFUND sem referência também', async () => {
    const wallet = await openWallet();
    await expectError(useCase.execute(command(wallet, Kind.Bet, { money: { amount: '0.00', currency: 'BRL' } })), InvalidWagerTransactionError);
    await expectError(useCase.execute(command(wallet, Kind.Refund)), InvalidWagerTransactionError);
  });

  test('wallet inexistente: WALLET_NOT_FOUND, sem persistir nada', async () => {
    const wallet = await openWallet();
    const missing = command(wallet, Kind.Bet, { walletId: randomUUID() });
    const error = await expectError(useCase.execute(missing), WalletNotFoundError);
    expect(error.code).toBe('WALLET_NOT_FOUND');
    expect(await uow.run((c) => c.transactions.findByIdempotencyKey(missing.idempotencyKey))).toBeUndefined();
    expect(await db.sql(`SELECT 1 FROM outbox_messages WHERE payload->'data'->>'walletId' = ?`, [missing.walletId])).toHaveLength(0);
  });
});

describe('referências', () => {
  test('ausente: PENDING_REFERENCE agendada, sem saldo, ledger nem versão', async () => {
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

  test('pendente fica disponível ao futuro retrier somente depois do prazo', async () => {
    const wallet = await openWallet();
    const at = new Date('2000-01-01T00:00:00.000Z');
    const { transactionId } = await buildUseCase(uow, { now: () => at }).execute(
      command(wallet, Kind.Win, { referenceExternalTransactionId: 'nao-chegou' }),
    );
    const due = (now: Date) => uow.run((c) => c.transactions.findDuePendingIds(now, 100));
    expect(await due(new Date('2000-01-01T00:00:04.000Z'))).not.toContain(transactionId);
    expect(await due(new Date('2000-01-01T00:00:05.000Z'))).toContain(transactionId);
  });

  test('o domínio retoma a pendente persistida quando a referência chega', async () => {
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

  test('referência que só existe em outro provider conta como ausente', async () => {
    const wallet = await openWallet();
    const betOtherProvider = command(wallet, Kind.Bet, { providerId: 'provider-b' });
    await useCase.execute(betOtherProvider);
    const result = await useCase.execute(
      command(wallet, Kind.Refund, { referenceExternalTransactionId: betOtherProvider.externalTransactionId }),
    );
    expect(result.status).toBe(Status.PendingReference);
    await assertConsistent(wallet.id);
  });

  test('referência ainda pendente: a operação também aguarda', async () => {
    const wallet = await openWallet();
    const win = command(wallet, Kind.Win, { referenceExternalTransactionId: 'bet-que-nao-chegou' });
    await useCase.execute(win);
    const result = await useCase.execute(command(wallet, Kind.Rollback, { referenceExternalTransactionId: win.externalTransactionId }));
    expect(result.status).toBe(Status.PendingReference);
    await expectNoEffect(wallet, '100.00', 1, 0);
  });

  test('tipo incompatível: REFUND de WIN é REFERENCE_KIND_INVALID', async () => {
    const wallet = await openWallet();
    const win = command(wallet, Kind.Win);
    await useCase.execute(win);
    const result = await useCase.execute(command(wallet, Kind.Refund, { referenceExternalTransactionId: win.externalTransactionId }));
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: 'REFERENCE_KIND_INVALID' });
    await expectNoEffect(wallet, '125.00', 2, 1);
  });

  test('rodada diferente é REFERENCE_MISMATCH', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet);
    await useCase.execute(bet);
    const result = await useCase.execute(
      command(wallet, Kind.Refund, { referenceExternalTransactionId: bet.externalTransactionId, roundId: 'round-2' }),
    );
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: 'REFERENCE_MISMATCH' });
    await expectNoEffect(wallet, '75.00', 2, 1);
  });

  test('wallet diferente é REFERENCE_MISMATCH, sem mexer em nenhuma das duas', async () => {
    const [wallet, other] = [await openWallet(), await openWallet()];
    const bet = command(wallet, Kind.Bet);
    await useCase.execute(bet);
    const result = await useCase.execute(command(other, Kind.Refund, { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: 'REFERENCE_MISMATCH' });
    await expectNoEffect(wallet, '75.00', 2, 1);
    await expectNoEffect(other, '100.00', 1, 0);
  });

  test('valor diferente na reversão é AMOUNT_MISMATCH', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet);
    await useCase.execute(bet);
    const result = await useCase.execute(
      command(wallet, Kind.Refund, { referenceExternalTransactionId: bet.externalTransactionId, money: { amount: '10.00', currency: 'BRL' } }),
    );
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: 'AMOUNT_MISMATCH' });
    await expectNoEffect(wallet, '75.00', 2, 1);
  });

  test('referência REJECTED é REFERENCE_NOT_PROCESSED', async () => {
    const wallet = await openWallet('10.00');
    const bet = command(wallet, Kind.Bet);
    await useCase.execute(bet);
    const result = await useCase.execute(command(wallet, Kind.Refund, { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: 'REFERENCE_NOT_PROCESSED' });
    await expectNoEffect(wallet, '10.00', 1, 0);
  });

  test('reversão duplicada: REFUND repetido é ALREADY_REVERSED e não credita de novo', async () => {
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

  test('REFUND e ROLLBACK da mesma operação são mutuamente exclusivos', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet);
    await useCase.execute(bet);
    const reference = { referenceExternalTransactionId: bet.externalTransactionId };
    await useCase.execute(command(wallet, Kind.Refund, reference));
    expect(await useCase.execute(command(wallet, Kind.Rollback, reference))).toMatchObject({ failureCode: 'ALREADY_REVERSED' });
    await expectNoEffect(wallet, '100.00', 3, 2);
  });

  test('reversão que deixaria o saldo negativo: REVERSAL_INSUFFICIENT_FUNDS, código distinto, auditável', async () => {
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

  test('uma reversão rejeitada não impede a reversão válida depois', async () => {
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

describe('idempotência', () => {
  test('replay idêntico devolve o resultado original com o saldo da época, sem efeitos', async () => {
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

  test('replay de REJECTED devolve a mesma rejeição, mesmo que agora houvesse saldo', async () => {
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

  test('replay de LOSS devolve o saldo observado, sem novo evento', async () => {
    const wallet = await openWallet();
    const loss = command(wallet, Kind.Loss);
    await useCase.execute(loss);
    await useCase.execute(command(wallet, Kind.Bet));
    const replay = await useCase.execute(loss);
    expect(replay.idempotentReplay).toBe(true);
    expect(moneyOf(replay)).toBe('100.00');
  });

  test('replay de PENDING_REFERENCE preserva identidade e estado, sem inventar saldo', async () => {
    const wallet = await openWallet();
    const refund = command(wallet, Kind.Refund, { referenceExternalTransactionId: 'ausente' });
    const first = await useCase.execute(refund);
    const replay = await useCase.execute(refund);
    expect(replay).toMatchObject({ transactionId: first.transactionId, status: Status.PendingReference, idempotentReplay: true });
    expect(replay.balance).toBeUndefined();
    expect((await eventsOf(wallet.id))).toHaveLength(1);
  });

  test('metadados de transporte não participam: correlationId diferente ainda é replay', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet, { correlationId: 'a', causationId: 'msg-1' });
    await useCase.execute(bet);
    const replay = await useCase.execute({ ...bet, correlationId: 'b', causationId: 'msg-2' });
    expect(replay.idempotentReplay).toBe(true);
  });

  test('o envelope guarda correlação e causa, com o dinheiro como string', async () => {
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

  test('conflito: mesma chave com payload diferente, sem efeito e sem alterar o original', async () => {
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

  test('conflito: mesmo id externo do provider com outra chave', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet);
    await useCase.execute(bet);
    await expectError(useCase.execute({ ...bet, idempotencyKey: 'outra-chave' }), IdempotencyConflictError);
    await expectNoEffect(wallet, '75.00', 2, 1);
  });

  test('conflito tem precedência sobre WALLET_NOT_FOUND', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet);
    await useCase.execute(bet);
    await expectError(useCase.execute({ ...bet, walletId: randomUUID() }), IdempotencyConflictError);
  });

  test('o mesmo id externo em providers diferentes são operações diferentes', async () => {
    const wallet = await openWallet();
    const externalTransactionId = randomUUID();
    await useCase.execute(command(wallet, Kind.Bet, { externalTransactionId }));
    const other = await useCase.execute(command(wallet, Kind.Bet, { externalTransactionId, providerId: 'provider-b' }));
    expect(other).toMatchObject({ status: Status.Processed, idempotentReplay: false });
    await expectNoEffect(wallet, '50.00', 3, 2);
  });

  test('o hash gravado é o do payload canônico', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet);
    const { transactionId } = await useCase.execute(bet);
    expect((await readTx(transactionId)).payloadHash).toBe(wagerPayloadHash({ ...bet, money: brl('25.00') }));
  });
});

describe('concorrência (PostgreSQL real)', () => {
  test('cenário obrigatório: 100.00 e duas BETs de 80.00', async () => {
    const wallet = await openWallet();
    const results = await Promise.all([
      useCase.execute(command(wallet, Kind.Bet, { money: { amount: '80.00', currency: 'BRL' } })),
      useCase.execute(command(wallet, Kind.Bet, { money: { amount: '80.00', currency: 'BRL' } })),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([Status.Processed, Status.Rejected]);
    expect(results.find((r) => r.status === Status.Rejected)?.failureCode).toBe(FailureCode.InsufficientFunds);
    await expectNoEffect(wallet, '20.00', 2, 1);
  }, CONCURRENCY_TIMEOUT);

  test('mesma chave 50 vezes ao mesmo tempo: um único efeito e 49 replays do mesmo resultado', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet);
    const results = await Promise.all(Array.from({ length: 50 }, () => useCase.execute(bet)));
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(new Set(results.map(moneyOf))).toEqual(new Set(['75.00']));
    await expectNoEffect(wallet, '75.00', 2, 1);
    expect(await eventsOf(wallet.id)).toHaveLength(2);
  }, CONCURRENCY_TIMEOUT);

  test('operações distintas simultâneas na mesma wallet: sem lost update nem negativo', async () => {
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

  test('a mesma wallet espera; wallets diferentes não se bloqueiam', async () => {
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

  test('muitas wallets em paralelo: cada uma fica correta', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet()));
    await Promise.all(
      wallets.flatMap((wallet) => [useCase.execute(command(wallet, Kind.Bet)), useCase.execute(command(wallet, Kind.Bet))]),
    );
    for (const wallet of wallets) await expectNoEffect(wallet, '50.00', 3, 2);
  }, CONCURRENCY_TIMEOUT);

  test('mesma chave em wallets diferentes: o lock não serializa; a unique decide, sem efeito no perdedor', async () => {
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

  test('mesma chave com payloads diferentes na mesma wallet: um vence, o outro é conflito', async () => {
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

  test('REFUND e ROLLBACK simultâneos da mesma BET: só uma reversão é aplicada', async () => {
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

  test('referência e reversão simultâneas: nada se perde, e nenhuma ordem duplica efeito', async () => {
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

  test('duas instâncias do caso de uso, sem nada em comum além do banco', async () => {
    const wallet = await openWallet();
    const other = buildUseCase(new MikroOrmUnitOfWork(db.orm, createPersistenceContext, 5000));
    const bet = command(wallet, Kind.Bet);
    const [a, b] = await Promise.all([useCase.execute(bet), other.execute(bet)]);
    expect([a.idempotentReplay, b.idempotentReplay].sort()).toEqual([false, true]);
    await expectNoEffect(wallet, '75.00', 2, 1);
  }, CONCURRENCY_TIMEOUT);
});

describe('atomicidade e classificação de falhas', () => {
  const fail = (message = 'falha injetada') => { throw new Error(message); };

  test.each<[string, (real: WageringPersistence) => Partial<WageringPersistence>]>([
    ['ao gravar a wallet', (real) => ({ wallets: overriding(real.wallets, { update: async () => fail() }) })],
    ['ao gravar o ledger', (real) => ({ ledger: overriding(real.ledger, { append: async () => fail() }) })],
    ['depois do primeiro evento', (real) => {
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
  ])('falha %s desfaz transação, saldo, ledger e eventos, e o reenvio aplica uma vez', async (_where, override) => {
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

  test('violação real de constraint: desfaz tudo e registra FAILED auditável, sem mover saldo', async () => {
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

  test('erro transitório real (lock timeout) não vira rejeição nem deixa rastro; o reenvio aplica', async () => {
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

  test('erro transitório com o banco disponível também não registra estado terminal', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet);
    const failing = buildUseCase(
      uowWith((real) => ({
        ledger: overriding(real.ledger, {
          append: async () => { throw new TransientInfrastructureError('conexão perdida'); },
        }),
      })),
    );
    await expectError(failing.execute(bet), TransientInfrastructureError);
    expect(await uow.run((c) => c.transactions.findByIdempotencyKey(bet.idempotencyKey))).toBeUndefined();
    await expectNoEffect(wallet, '100.00', 1, 0);
    expect(await useCase.execute(bet)).toMatchObject({ status: Status.Processed, idempotentReplay: false });
  });

  test('falha inesperada é propagada sem registrar estado terminal', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet);
    const failing = buildUseCase(uowWith((real) => ({ outbox: overriding(real.outbox, { enqueue: async () => fail('defeito') }) })));
    const error = await expectError(failing.execute(bet), Error);
    expect(error.message).toBe('defeito');
    expect(await uow.run((c) => c.transactions.findByIdempotencyKey(bet.idempotencyKey))).toBeUndefined();
  });

  test('se registrar FAILED também falhar, prevalece o erro original', async () => {
    const wallet = await openWallet();
    const bet = command(wallet, Kind.Bet);
    let calls = 0;
    const flaky: UnitOfWork<WageringPersistence> = {
      run: async (work) => {
        if (++calls === 2) throw new TransientInfrastructureError('banco fora');
        return uow.run(() => { throw new PersistenceConstraintError('original'); }) as never;
      },
    };
    const error = await expectError(buildUseCase(flaky).execute(bet), PersistenceConstraintError);
    expect(error.constraint).toBe('original');
    expect(calls).toBe(2);
    await expectNoEffect(wallet, '100.00', 1, 0);
  });

  test('versão só muda com saldo: a sequência completa mantém o invariante', async () => {
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

describe('injeção de dependências', () => {
  test('o Nest entrega o caso de uso pronto, ligado ao banco configurado', async () => {
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
