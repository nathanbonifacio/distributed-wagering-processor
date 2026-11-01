import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiModule } from '../../src/api.module';
import { HealthController } from '../../src/app/health/health.controller';
import { WageringController } from '../../src/app/wagering/presentation/wagering.controller';
import { WalletOpeningController } from '../../src/app/wagering/presentation/wallet-opening.controller';
import { WalletController } from '../../src/app/wallet/presentation/wallet.controller';
import { decodeLedgerCursor, encodeLedgerCursor } from '../../src/app/wallet/presentation/ledger-cursor';
import { wagerPayloadHash } from '../../src/app/wagering/application/wager-payload-hash';
import { FailureCode } from '../../src/app/wagering/domain/failure-code';
import { WagerTransaction, WagerTransactionKind } from '../../src/app/wagering/domain/wager-transaction.entity';
import { MikroOrmUnitOfWork } from '../../src/database/mikro-orm-unit-of-work';
import { createPersistenceContext, PERSISTENCE_SCHEMAS } from '../../src/persistence.module';
import { Money } from '../../src/shared/domain/money';
import { testEnv } from '../support/env';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

// Pré-requisito: `docker compose up -d postgres localstack`. A API real (ApiModule, o mesmo do main.api.ts)
// escuta em uma porta local, com PostgreSQL real e descartável. Todas as chamadas são HTTP de verdade.
const CONCURRENCY_TIMEOUT = 30_000;

let db: TestDatabase;
let app: INestApplication;
let baseUrl: string;

async function startApi(overrides: Record<string, string>) {
  const started = await NestFactory.create(ApiModule.register(testEnv(overrides)), { logger: false });
  await started.listen(0);
  return { app: started, url: await started.getUrl() };
}

beforeAll(async () => {
  db = await createTestDatabase({ entities: PERSISTENCE_SCHEMAS });
  await db.orm.migrator.up();
  ({ app, url: baseUrl } = await startApi({ DATABASE_URL: db.url }));
});
afterAll(async () => {
  await app.close();
  await db.drop();
});

interface Reply {
  status: number;
  body: any;
  headers: Headers;
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, url = baseUrl): Promise<Reply> {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers };
}

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function openWallet(amount = '100.00', playerId: string = randomUUID()) {
  const reply = await call('POST', '/wallets', { playerId, initialBalance: brl(amount) });
  expect(reply.status).toBe(201);
  return reply.body as { id: string; playerId: string; balance: { amount: string; currency: string }; version: number };
}

type Wallet = Awaited<ReturnType<typeof openWallet>>;

function payload(wallet: Wallet, kind: string, overrides: Record<string, unknown> = {}) {
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

const submit = (body: any, key: string = `${body.providerId}:${body.externalTransactionId}`) =>
  call('POST', '/wagering/transactions', body, { 'Idempotency-Key': key });

async function ledger(walletId: string) {
  return (await call('GET', `/wallets/${walletId}/ledger?limit=200`)).body.entries as any[];
}

/** Invariante final do README: saldo igual ao reconstruído pelo ledger, pela própria API e pelo banco. */
async function assertConsistent(walletId: string) {
  const wallet = (await call('GET', `/wallets/${walletId}`)).body;
  const [row] = await db.sql<any>(
    `SELECT w.balance::text AS stored, w.version,
            COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(20,2)::text AS rebuilt,
            COALESCE(MAX(l.wallet_version), 1) AS max_version
     FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
     WHERE w.id = ? GROUP BY w.id`,
    [walletId],
  );
  expect(row!.rebuilt).toBe(row!.stored);
  expect(row!.version).toBe(row!.max_version);
  expect(wallet.balance.amount).toBe(row!.stored);
  expect(wallet.version).toBe(row!.version);
}

const countRows = async (table: string, column: string, value: string) =>
  ((await db.sql(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = ?`, [value]))[0] as any).n as number;

describe('POST /wallets', () => {
  test('positive balance: README contract, with OPENING, ledger entry and atomic events', async () => {
    const playerId = randomUUID();
    const reply = await call('POST', '/wallets', { playerId, initialBalance: brl('1000.00') });
    expect(reply.status).toBe(201);
    expect(reply.body).toEqual({ id: expect.any(String), playerId, balance: brl('1000.00'), version: 1 });

    const walletId = reply.body.id;
    const external = `opening:${walletId}`;
    const opening = await call('GET', `/providers/internal/wagering/transactions/${encodeURIComponent(external)}`);
    expect(opening.body).toMatchObject({ kind: 'OPENING', status: 'PROCESSED', balance: brl('1000.00'), walletId });

    const entries = await ledger(walletId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      transactionId: opening.body.id,
      direction: 'CREDIT',
      walletVersion: 1,
      money: brl('1000.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('1000.00'),
    });
    const events = await db.sql(`SELECT event_type FROM outbox_messages WHERE payload->'data'->>'walletId' = ? ORDER BY event_type`, [walletId]);
    expect(events.map((e: any) => e.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    await assertConsistent(walletId);
  });

  test('zero balance: no transaction, ledger entry or event', async () => {
    const wallet = await openWallet('0.00');
    expect(wallet).toMatchObject({ balance: brl('0.00'), version: 1 });
    expect(await countRows('wager_transactions', 'wallet_id', wallet.id)).toBe(0);
    expect(await ledger(wallet.id)).toHaveLength(0);
    expect((await db.sql(`SELECT 1 FROM outbox_messages WHERE payload->'data'->>'walletId' = ?`, [wallet.id]))).toHaveLength(0);
    await assertConsistent(wallet.id);
  });

  test('duplicate for the same player and currency: stable 409, no new row', async () => {
    const playerId = randomUUID();
    await openWallet('10.00', playerId);
    const reply = await call('POST', '/wallets', { playerId, initialBalance: brl('20.00') });
    expect(reply.status).toBe(409);
    expect(reply.body.code).toBe('WALLET_ALREADY_EXISTS');
    expect(await countRows('wallets', 'player_id', playerId)).toBe(1);
  });

  test('the same player can have wallets in different currencies', async () => {
    const playerId = randomUUID();
    await openWallet('10.00', playerId);
    const usd = await call('POST', '/wallets', { playerId, initialBalance: { amount: '5.00', currency: 'USD' } });
    expect(usd.status).toBe(201);
  });

  test('simultaneous duplicate opening: the constraint decides, one 201 and the rest 409', async () => {
    const playerId = randomUUID();
    const replies = await Promise.all(
      Array.from({ length: 10 }, () => call('POST', '/wallets', { playerId, initialBalance: brl('10.00') })),
    );
    expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
    expect(replies.filter((r) => r.status === 409)).toHaveLength(9);
    await assertConsistent(replies.find((r) => r.status === 201)!.body.id);
    expect(await countRows('wallets', 'player_id', playerId)).toBe(1);
  }, CONCURRENCY_TIMEOUT);

  test.each<[string, unknown]>([
    ['invalid player', { playerId: 'x', initialBalance: brl('1.00') }],
    ['no balance', { playerId: randomUUID() }],
    ['amount as number', { playerId: randomUUID(), initialBalance: { amount: 10, currency: 'BRL' } }],
    ['wrong scale', { playerId: randomUUID(), initialBalance: brl('10') }],
    ['negative', { playerId: randomUUID(), initialBalance: brl('-1.00') }],
    ['invalid currency', { playerId: randomUUID(), initialBalance: { amount: '1.00', currency: 'brl' } }],
    ['extra field', { playerId: randomUUID(), initialBalance: brl('1.00'), version: 7 }],
  ])('invalid payload is 400: %s', async (_name, body) => {
    const reply = await call('POST', '/wallets', body);
    expect(reply.status).toBe(400);
    expect(reply.body.code).toBe('INVALID_PAYLOAD');
  });
});

describe('GET /wallets/:walletId', () => {
  test('returns the contract, with the balance as a string and nothing internal from the ORM', async () => {
    const wallet = await openWallet('12.30');
    const reply = await call('GET', `/wallets/${wallet.id}`);
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ id: wallet.id, playerId: wallet.playerId, balance: brl('12.30'), version: 1 });
  });

  test('an uppercase UUID is the same wallet', async () => {
    const wallet = await openWallet();
    expect((await call('GET', `/wallets/${wallet.id.toUpperCase()}`)).body.id).toBe(wallet.id);
  });

  test('nonexistent is 404; malformed id is 400', async () => {
    const missing = await call('GET', `/wallets/${randomUUID()}`);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('WALLET_NOT_FOUND');
    expect((await call('GET', '/wallets/nao-e-uuid')).status).toBe(400);
  });
});

describe('GET /wallets/:walletId/ledger', () => {
  async function walletWithEntries(count: number) {
    const wallet = await openWallet('1000.00');
    for (let i = 0; i < count; i++) {
      expect((await submit(payload(wallet, 'BET', { money: brl('1.00') }))).status).toBe(201);
    }
    return wallet;
  }

  test('carries what is needed for auditing, in order', async () => {
    const wallet = await walletWithEntries(2);
    const { body, status } = await call('GET', `/wallets/${wallet.id}/ledger`);
    expect(status).toBe(200);
    expect(body.nextCursor).toBeNull();
    expect(body.entries.map((e: any) => e.walletVersion)).toEqual([1, 2, 3]);
    expect(Object.keys(body.entries[0]).sort()).toEqual(
      ['balanceAfter', 'balanceBefore', 'createdAt', 'direction', 'id', 'money', 'transactionId', 'walletVersion'].sort(),
    );
  });

  test('stable pagination: entries inserted between pages neither repeat nor skip anything', async () => {
    const wallet = await walletWithEntries(4);
    const seen: number[] = [];
    let page = (await call('GET', `/wallets/${wallet.id}/ledger?limit=2`)).body;
    seen.push(...page.entries.map((e: any) => e.walletVersion));

    await submit(payload(wallet, 'BET', { money: brl('1.00') }));
    await submit(payload(wallet, 'WIN', { money: brl('1.00') }));

    while (page.nextCursor) {
      page = (await call('GET', `/wallets/${wallet.id}/ledger?limit=2&cursor=${page.nextCursor}`)).body;
      seen.push(...page.entries.map((e: any) => e.walletVersion));
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7]);
    await assertConsistent(wallet.id);
  });

  test('a full last page leads to an empty page, with no new cursor', async () => {
    const wallet = await walletWithEntries(1);
    const first = (await call('GET', `/wallets/${wallet.id}/ledger?limit=2`)).body;
    expect(first.entries).toHaveLength(2);
    const last = (await call('GET', `/wallets/${wallet.id}/ledger?limit=2&cursor=${first.nextCursor}`)).body;
    expect(last).toEqual({ entries: [], nextCursor: null });
  });

  test('the cursor is opaque, not the seq', async () => {
    const wallet = await walletWithEntries(1);
    const { nextCursor } = (await call('GET', `/wallets/${wallet.id}/ledger?limit=1`)).body;
    expect(nextCursor).not.toMatch(/^\d+$/);
    expect(encodeLedgerCursor(decodeLedgerCursor(nextCursor)!)).toBe(nextCursor);
  });

  test.each([
    ['limit=0'],
    ['limit=201'],
    ['limit=abc'],
    ['limit=1e2'],
    ['limit=-1'],
    ['limit=5.5'],
    ['cursor=!!!'],
    [`cursor=${Buffer.from('abc').toString('base64url')}`],
    [`cursor=${Buffer.from('99999999999999999999').toString('base64url')}`],
    [`cursor=${Buffer.from('9999999999999999999').toString('base64url')}`],
    ['outro=1'],
  ])('invalid query is 400: %s', async (query) => {
    const wallet = await openWallet();
    const reply = await call('GET', `/wallets/${wallet.id}/ledger?${query}`);
    expect(reply.status).toBe(400);
    expect(reply.body.code).toBe('INVALID_PAYLOAD');
  });

  test('nonexistent wallet is 404', async () => {
    expect((await call('GET', `/wallets/${randomUUID()}/ledger`)).status).toBe(404);
  });
});

describe('GET of transactions', () => {
  test('by internal id and by provider + external id return the same transaction', async () => {
    const wallet = await openWallet();
    const bet = payload(wallet, 'BET');
    const { body: submitted } = await submit(bet);

    const byId = await call('GET', `/wagering/transactions/${submitted.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({
      id: submitted.transactionId,
      providerId: 'provider-a',
      externalTransactionId: bet.externalTransactionId,
      kind: 'BET',
      status: 'PROCESSED',
      money: brl('25.00'),
      balance: brl('75.00'),
      failureCode: null,
    });
    expect(byId.body.processedAt).toEqual(expect.any(String));
    const byProvider = await call('GET', `/providers/provider-a/wagering/transactions/${bet.externalTransactionId}`);
    expect(byProvider.body).toEqual(byId.body);
  });

  test('the external id is scoped to the provider', async () => {
    const wallet = await openWallet();
    const bet = payload(wallet, 'BET');
    await submit(bet);
    expect((await call('GET', `/providers/provider-b/wagering/transactions/${bet.externalTransactionId}`)).status).toBe(404);
  });

  test('a rejected one shows the failureCode; nonexistent is 404; malformed id is 400', async () => {
    const wallet = await openWallet('1.00');
    const { body } = await submit(payload(wallet, 'BET'));
    expect((await call('GET', `/wagering/transactions/${body.transactionId}`)).body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: brl('1.00'),
    });
    const missing = await call('GET', `/wagering/transactions/${randomUUID()}`);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('TRANSACTION_NOT_FOUND');
    expect((await call('GET', '/wagering/transactions/123')).status).toBe(400);
    expect((await call('GET', '/providers/provider-a/wagering/transactions/a%00b')).status).toBe(400);
  });
});

describe('POST /wagering/transactions', () => {
  test('BET: 201 with the exact README contract', async () => {
    const wallet = await openWallet('1000.00');
    const reply = await submit(payload(wallet, 'BET'));
    expect(reply.status).toBe(201);
    expect(reply.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: brl('975.00'),
      idempotentReplay: false,
    });
    await assertConsistent(wallet.id);
  });

  test('WIN: 201 and credit', async () => {
    const wallet = await openWallet();
    const reply = await submit(payload(wallet, 'WIN'));
    expect(reply.status).toBe(201);
    expect(reply.body.balance).toEqual(brl('125.00'));
    await assertConsistent(wallet.id);
  });

  test('LOSS: 201 with no movement and no new version', async () => {
    const wallet = await openWallet();
    const reply = await submit(payload(wallet, 'LOSS'));
    expect(reply.status).toBe(201);
    expect(reply.body.balance).toEqual(brl('100.00'));
    expect(await ledger(wallet.id)).toHaveLength(1);
    expect((await call('GET', `/wallets/${wallet.id}`)).body.version).toBe(1);
  });

  test('valid REFUND: 201 and returns the amount', async () => {
    const wallet = await openWallet();
    const bet = payload(wallet, 'BET');
    await submit(bet);
    const reply = await submit(payload(wallet, 'REFUND', { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(reply.status).toBe(201);
    expect(reply.body.balance).toEqual(brl('100.00'));
    await assertConsistent(wallet.id);
  });

  test('valid ROLLBACK: 201 with the inverse of the reference; repeated as a new operation it is 422', async () => {
    const wallet = await openWallet();
    const win = payload(wallet, 'WIN');
    await submit(win);
    const reference = { referenceExternalTransactionId: win.externalTransactionId };
    const reply = await submit(payload(wallet, 'ROLLBACK', reference));
    expect(reply.status).toBe(201);
    expect(reply.body.balance).toEqual(brl('100.00'));
    const again = await submit(payload(wallet, 'ROLLBACK', reference));
    expect(again.status).toBe(422);
    expect(again.body.failureCode).toBe('ALREADY_REVERSED');
    await assertConsistent(wallet.id);
  });

  test('BET without funds: 422 with status and failureCode, no effect', async () => {
    const wallet = await openWallet('10.00');
    const reply = await submit(payload(wallet, 'BET'));
    expect(reply.status).toBe(422);
    expect(reply.body).toEqual({
      transactionId: expect.any(String),
      status: 'REJECTED',
      balance: brl('10.00'),
      failureCode: 'INSUFFICIENT_FUNDS',
      idempotentReplay: false,
    });
    await assertConsistent(wallet.id);
  });

  test.each<[string, string, Record<string, unknown>]>([
    ['REFERENCE_KIND_INVALID', 'REFUND', {}],
    ['AMOUNT_MISMATCH', 'ROLLBACK', { money: brl('1.00') }],
    ['REFERENCE_MISMATCH', 'ROLLBACK', { roundId: 'outra' }],
  ])('mismatched reference is 422: %s', async (failureCode, kind, overrides) => {
    const wallet = await openWallet();
    const win = payload(wallet, 'WIN');
    await submit(win);
    const reply = await submit(payload(wallet, kind, { referenceExternalTransactionId: win.externalTransactionId, ...overrides }));
    expect(reply.status).toBe(422);
    expect(reply.body.failureCode).toBe(failureCode);
  });

  test('a reversal that would leave a negative balance is 422 with a distinct code', async () => {
    const wallet = await openWallet('0.00');
    const win = payload(wallet, 'WIN');
    await submit(win);
    await submit(payload(wallet, 'BET', { money: brl('20.00') }));
    const reply = await submit(payload(wallet, 'ROLLBACK', { referenceExternalTransactionId: win.externalTransactionId }));
    expect(reply.status).toBe(422);
    expect(reply.body.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    await assertConsistent(wallet.id);
  });

  test('PENDING_REFERENCE: 202 without balance, persisted and scheduled; the replay is still 202', async () => {
    const wallet = await openWallet();
    const refund = payload(wallet, 'REFUND', { referenceExternalTransactionId: 'ainda-nao-chegou' });
    const reply = await submit(refund);
    expect(reply.status).toBe(202);
    expect(reply.body).toEqual({ transactionId: expect.any(String), status: 'PENDING_REFERENCE', idempotentReplay: false });
    expect((await call('GET', `/wagering/transactions/${reply.body.transactionId}`)).body).toMatchObject({
      status: 'PENDING_REFERENCE',
      balance: null,
      attempts: 0,
      nextAttemptAt: expect.any(String),
    });
    const replay = await submit(refund);
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual({ ...reply.body, idempotentReplay: true });
    await assertConsistent(wallet.id);
  });

  test('replay: 200, same id and the historical balance, no new effect', async () => {
    const wallet = await openWallet();
    const bet = payload(wallet, 'BET');
    const first = await submit(bet);
    await submit(payload(wallet, 'WIN', { money: brl('500.00') }));

    const replay = await submit(bet);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(replay.body.balance).toEqual(brl('75.00'));
    expect((await call('GET', `/wallets/${wallet.id}`)).body.balance).toEqual(brl('575.00'));
    expect(await ledger(wallet.id)).toHaveLength(3);
    await assertConsistent(wallet.id);
  });

  test('replay of a rejection is still 422', async () => {
    const wallet = await openWallet('1.00');
    const bet = payload(wallet, 'BET');
    await submit(bet);
    const replay = await submit(bet);
    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({ failureCode: 'INSUFFICIENT_FUNDS', idempotentReplay: true });
  });

  test('replay of FAILED: 500 with the audited state, without applying on top', async () => {
    const wallet = await openWallet();
    const bet = payload(wallet, 'BET');
    const money = Money.from(bet.money);
    const failed = WagerTransaction.create({
      ...bet,
      id: randomUUID(),
      idempotencyKey: `provider-a:${bet.externalTransactionId}`,
      payloadHash: wagerPayloadHash({ ...bet, kind: WagerTransactionKind.Bet, money }),
      kind: WagerTransactionKind.Bet,
      money,
      createdAt: new Date(),
    });
    failed.fail(FailureCode.InternalError, new Date());
    await new MikroOrmUnitOfWork(db.orm, createPersistenceContext, 5000).run((c) => c.transactions.insertIfAbsent(failed));

    const reply = await submit(bet);
    expect(reply.status).toBe(500);
    expect(reply.body).toEqual({ transactionId: failed.id, status: 'FAILED', failureCode: 'INTERNAL_ERROR', idempotentReplay: true });
    expect((await call('GET', `/wallets/${wallet.id}`)).body.balance).toEqual(brl('100.00'));
    await assertConsistent(wallet.id);
  });

  test('the order of the JSON keys does not change the identity of the request', async () => {
    const wallet = await openWallet();
    const bet = payload(wallet, 'BET');
    await submit(bet);
    const reordered = Object.fromEntries(Object.entries(bet).reverse());
    const replay = await submit(reordered, `provider-a:${bet.externalTransactionId}`);
    expect(replay.status).toBe(200);
  });

  test('an uppercase UUID is the same operation: replay, and never PLAYER_WALLET_MISMATCH', async () => {
    const wallet = await openWallet();
    const bet = payload(wallet, 'BET');
    const first = await submit(payload(wallet, 'BET', { ...bet, playerId: wallet.playerId.toUpperCase(), walletId: wallet.id.toUpperCase() }), `k:${bet.externalTransactionId}`);
    expect(first.status).toBe(201);
    expect((await submit(bet, `k:${bet.externalTransactionId}`)).status).toBe(200);
  });

  test('same key with a different payload: 409, no effect', async () => {
    const wallet = await openWallet();
    const bet = payload(wallet, 'BET');
    await submit(bet);
    const reply = await submit({ ...bet, money: brl('26.00') });
    expect(reply.status).toBe(409);
    expect(reply.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await call('GET', `/wallets/${wallet.id}`)).body.balance).toEqual(brl('75.00'));
    await assertConsistent(wallet.id);
  });

  test('nonexistent wallet: 422 WALLET_NOT_FOUND, nothing persisted', async () => {
    const wallet = await openWallet();
    const missing = payload(wallet, 'BET', { walletId: randomUUID() });
    const reply = await submit(missing);
    expect(reply.status).toBe(422);
    expect(reply.body.code).toBe('WALLET_NOT_FOUND');
    expect(await countRows('wager_transactions', 'external_transaction_id', missing.externalTransactionId)).toBe(0);
  });

  test('a wallet of another player is a business rejection', async () => {
    const wallet = await openWallet();
    const reply = await submit(payload(wallet, 'BET', { playerId: randomUUID() }));
    expect(reply.status).toBe(422);
    expect(reply.body.failureCode).toBe('PLAYER_WALLET_MISMATCH');
  });

  test('missing or empty Idempotency-Key: 400, nothing written', async () => {
    const wallet = await openWallet();
    const bet = payload(wallet, 'BET');
    const absent = await call('POST', '/wagering/transactions', bet);
    expect(absent.status).toBe(400);
    expect(absent.body.code).toBe('INVALID_PAYLOAD');
    expect(absent.body.issues[0].path).toBe('Idempotency-Key');
    expect((await call('POST', '/wagering/transactions', bet, { 'Idempotency-Key': '' })).status).toBe(400);
    expect(await countRows('wager_transactions', 'external_transaction_id', bet.externalTransactionId)).toBe(0);
  });

  test('external OPENING and reserved provider: 400, nothing written', async () => {
    const wallet = await openWallet();
    const opening = payload(wallet, 'OPENING');
    const external = await submit(opening);
    expect(external.status).toBe(400);
    expect(external.body.issues[0].path).toBe('kind');
    const reserved = await submit(payload(wallet, 'BET', { providerId: 'internal' }));
    expect(reserved.status).toBe(400);
    expect(reserved.body.issues[0].path).toBe('providerId');
    expect(await countRows('wager_transactions', 'external_transaction_id', opening.externalTransactionId)).toBe(0);
    await assertConsistent(wallet.id);
  });

  test.each<[string, Record<string, unknown>]>([
    ['amount as number', { money: { amount: 25, currency: 'BRL' } }],
    ['amount without scale', { money: brl('25') }],
    ['more than 2 decimal places', { money: brl('25.001') }],
    ['scientific notation', { money: brl('1e2') }],
    ['negative', { money: brl('-1.00') }],
    ['lowercase currency', { money: { amount: '1.00', currency: 'brl' } }],
    ['unknown kind', { kind: 'JACKPOT' }],
    ['invalid playerId', { playerId: 'abc' }],
    ['invalid walletId', { walletId: 'abc' }],
    ['empty roundId', { roundId: '' }],
    ['gameId with NUL', { gameId: 'a\u0000b' }],
    ['missing provider', { providerId: undefined }],
    ['long external id', { externalTransactionId: 'x'.repeat(256) }],
    ['unknown field', { extra: true }],
    ['null reference', { referenceExternalTransactionId: null }],
    ['BET with a reference', { referenceExternalTransactionId: 'y' }],
    ['BET with zero amount', { money: brl('0.00') }],
  ])('invalid payload is 400: %s', async (_name, overrides) => {
    const wallet = await openWallet();
    const reply = await call('POST', '/wagering/transactions', payload(wallet, 'BET', overrides), { 'Idempotency-Key': randomUUID() });
    expect(reply.status).toBe(400);
    expect(reply.body.code).toBe('INVALID_PAYLOAD');
    await assertConsistent(wallet.id);
  });

  test('REFUND and ROLLBACK without a reference: 400', async () => {
    const wallet = await openWallet();
    expect((await submit(payload(wallet, 'REFUND'))).status).toBe(400);
    expect((await submit(payload(wallet, 'ROLLBACK'))).status).toBe(400);
  });

  test('malformed JSON: 400, without echoing the body in the response', async () => {
    const reply = await call('POST', '/wagering/transactions', '{"segredo":', { 'Idempotency-Key': 'k' });
    expect(reply.status).toBe(400);
    expect(reply.body.code).toBe('INVALID_PAYLOAD');
    expect(JSON.stringify(reply.body)).not.toContain('segredo');
  });
});

describe('concurrency through the API', () => {
  test('two BETs of 80.00 over 100.00: one approved, one rejected, balance 20.00 and one debit', async () => {
    const wallet = await openWallet('100.00');
    const replies = await Promise.all([
      submit(payload(wallet, 'BET', { money: brl('80.00') })),
      submit(payload(wallet, 'BET', { money: brl('80.00') })),
    ]);
    expect(replies.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(replies.find((r) => r.status === 422)!.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect((await call('GET', `/wallets/${wallet.id}`)).body).toMatchObject({ balance: brl('20.00'), version: 2 });
    expect((await ledger(wallet.id)).filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
    await assertConsistent(wallet.id);
  }, CONCURRENCY_TIMEOUT);

  test('the same BET 50 times: one 201, 49 replays and a single debit', async () => {
    const wallet = await openWallet();
    const bet = payload(wallet, 'BET');
    const replies = await Promise.all(Array.from({ length: 50 }, () => submit(bet)));
    expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
    expect(replies.filter((r) => r.status === 200)).toHaveLength(49);
    expect(new Set(replies.map((r) => r.body.transactionId)).size).toBe(1);
    expect((await ledger(wallet.id)).filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
    await assertConsistent(wallet.id);
  }, CONCURRENCY_TIMEOUT);
});

describe('errors and infrastructure', () => {
  test('real lock timeout: 503 with Retry-After, no definitive rejection; the resend applies', async () => {
    const wallet = await openWallet();
    const bet = payload(wallet, 'BET');
    const impatient = await startApi({ DATABASE_URL: db.url, DB_LOCK_TIMEOUT_MS: '100' });
    const blocker = db.orm.em.fork();
    try {
      await blocker.transactional(async (em) => {
        await em.execute('SELECT 1 FROM wallets WHERE id = ? FOR UPDATE', [wallet.id]);
        const reply = await call('POST', '/wagering/transactions', bet, { 'Idempotency-Key': `k:${bet.externalTransactionId}` }, impatient.url);
        expect(reply.status).toBe(503);
        expect(reply.body.code).toBe('TEMPORARILY_UNAVAILABLE');
        expect(reply.headers.get('retry-after')).toBe('1');
      });
    } finally {
      await impatient.app.close();
    }
    expect(await countRows('wager_transactions', 'external_transaction_id', bet.externalTransactionId)).toBe(0);
    expect((await submit(bet, `k:${bet.externalTransactionId}`)).status).toBe(201);
    await assertConsistent(wallet.id);
  }, CONCURRENCY_TIMEOUT);

  test('database unreachable: 503 on queries too, without leaking address or SQL', async () => {
    const down = await startApi({ DATABASE_URL: 'postgres://wagering:segredo@127.0.0.1:1/wagering', DB_CONNECT_TIMEOUT_MS: '500' });
    try {
      const reply = await call('GET', `/wallets/${randomUUID()}`, undefined, {}, down.url);
      expect(reply.status).toBe(503);
      expect(reply.body.code).toBe('TEMPORARILY_UNAVAILABLE');
      const text = JSON.stringify(reply.body);
      for (const leak of ['segredo', '127.0.0.1', 'select', 'stack']) expect(text.toLowerCase()).not.toContain(leak);
    } finally {
      await down.app.close();
    }
  }, CONCURRENCY_TIMEOUT);

  test('nonexistent route: 404 in the same error contract', async () => {
    const reply = await call('GET', '/nao-existe');
    expect(reply.status).toBe(404);
    expect(reply.body.code).toBe('NOT_FOUND');
  });

  test('health stays public and with its own format', async () => {
    expect((await call('GET', '/health/live')).body).toEqual({ status: 'ok' });
    const ready = await call('GET', '/health/ready');
    expect(ready.status).toBe(200);
    expect(Object.keys(ready.body.checks).sort()).toEqual(['postgres', 'sqs', 'sqsEvents']);
  });

  test('the authentication guard is on the business routes and outside health', () => {
    const guards = (target: object): unknown[] => Reflect.getMetadata('__guards__', target) ?? [];
    for (const controller of [WalletController, WalletOpeningController, WageringController]) {
      expect(guards(controller)).toHaveLength(1);
    }
    expect(guards(HealthController)).toHaveLength(0);
  });
});
