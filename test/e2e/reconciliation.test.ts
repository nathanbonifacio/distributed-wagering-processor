import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Logger, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiModule } from '../../src/api.module';
import { PERSISTENCE_SCHEMAS } from '../../src/persistence.module';
import { testEnv } from '../support/env';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

// Prerequisite: `docker compose up -d postgres localstack`. The real API over real PostgreSQL, called over HTTP.
let db: TestDatabase;
let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  db = await createTestDatabase({ entities: PERSISTENCE_SCHEMAS });
  await db.orm.migrator.up();
  app = await NestFactory.create(ApiModule.register(testEnv({ DATABASE_URL: db.url })), { logger: false });
  await app.listen(0);
  baseUrl = await app.getUrl();
});
afterAll(async () => {
  await app.close();
  await db.drop();
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

const money = (amount: string, currency = 'BRL') => ({ amount, currency });

async function openWallet(amount: string, currency = 'BRL', playerId: string = randomUUID()) {
  const reply = await call('POST', '/wallets', { playerId, initialBalance: money(amount, currency) });
  expect(reply.status).toBe(201);
  return reply.body as { id: string; playerId: string };
}

type Wallet = Awaited<ReturnType<typeof openWallet>>;

const payload = (wallet: Wallet, kind: string, overrides: Record<string, unknown> = {}) => ({
  providerId: 'provider-a',
  externalTransactionId: randomUUID(),
  playerId: wallet.playerId,
  walletId: wallet.id,
  roundId: 'round-1',
  gameId: 'fortune-chimp',
  kind,
  money: money('25.00'),
  ...overrides,
});

const submit = (body: any) =>
  call('POST', '/wagering/transactions', body, { 'Idempotency-Key': `${body.providerId}:${body.externalTransactionId}` });

const reconcile = (walletId: string) => call('POST', `/wallets/${walletId}/reconciliation`);

const snapshotOf = async (walletId: string) => ({
  wallet: (await db.sql(`SELECT balance::text AS balance, version FROM wallets WHERE id = ?`, [walletId]))[0],
  ledger: await db.sql(`SELECT id, direction, amount::text AS amount, wallet_version FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY seq`, [walletId]),
});

afterEach(() => {
  // Each test installs its own spies; restoring here keeps the logger untouched for the next one.
  (Logger.prototype.error as any).mockRestore?.();
});

describe('POST /wallets/:walletId/reconciliation: consistent wallets', () => {
  test('matches the README contract exactly after a mix of operations', async () => {
    const wallet = await openWallet('1000.00');
    const bet = payload(wallet, 'BET', { money: money('100.00') });
    await submit(bet);
    await submit(payload(wallet, 'WIN', { money: money('40.50') }));
    await submit(payload(wallet, 'LOSS'));
    await submit(payload(wallet, 'REFUND', { money: money('100.00'), referenceExternalTransactionId: bet.externalTransactionId }));
    await submit(payload(wallet, 'BET', { money: money('5000.00') })); // rejected: no ledger entry

    const reply = await reconcile(wallet.id);
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      walletId: wallet.id,
      storedBalance: money('1040.50'),
      calculatedBalance: money('1040.50'),
      difference: money('0.00'),
      consistent: true,
      checkedEntries: 4,
    });
    const entries = (await call('GET', `/wallets/${wallet.id}/ledger?limit=200`)).body.entries;
    expect(reply.body.checkedEntries).toBe(entries.length);
  });

  test('a wallet opened empty has no entries and reconciles to zero', async () => {
    const wallet = await openWallet('0.00');
    expect((await reconcile(wallet.id)).body).toEqual({
      walletId: wallet.id,
      storedBalance: money('0.00'),
      calculatedBalance: money('0.00'),
      difference: money('0.00'),
      consistent: true,
      checkedEntries: 0,
    });
  });

  test('is read-only: repeating it changes nothing in the wallet or the ledger', async () => {
    const wallet = await openWallet('50.00');
    await submit(payload(wallet, 'BET'));
    const before = await snapshotOf(wallet.id);
    const replies = await Promise.all([reconcile(wallet.id), reconcile(wallet.id), reconcile(wallet.id)]);
    expect(replies.map((r) => r.body.consistent)).toEqual([true, true, true]);
    expect(await snapshotOf(wallet.id)).toEqual(before);
  });
});

describe('POST /wallets/:walletId/reconciliation: divergences', () => {
  test('a stored balance above the ledger is reported, logged and never corrected', async () => {
    const wallet = await openWallet('100.00');
    await submit(payload(wallet, 'BET'));
    await db.sql(`UPDATE wallets SET balance = balance + 7.50 WHERE id = ?`, [wallet.id]);
    const before = await snapshotOf(wallet.id);
    const logged = spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const reply = await reconcile(wallet.id);

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      walletId: wallet.id,
      storedBalance: money('82.50'),
      calculatedBalance: money('75.00'),
      difference: money('7.50'),
      consistent: false,
      checkedEntries: 2,
    });
    // Logged with what is needed to diagnose, and without the balances themselves.
    expect(logged).toHaveBeenCalledTimes(1);
    const message = JSON.stringify(logged.mock.calls[0]?.[0]);
    expect(message).toContain(wallet.id);
    expect(message).toContain('7.50');
    expect(message).not.toContain('82.50');
    expect(message).not.toContain('75.00');
    // Nothing was fixed, silently or otherwise: the same call reports the same divergence.
    expect(await snapshotOf(wallet.id)).toEqual(before);
    expect((await reconcile(wallet.id)).body.consistent).toBe(false);
    expect(logged).toHaveBeenCalledTimes(2);
  });

  test('a stored balance below the ledger gives a negative difference with exact decimals', async () => {
    const wallet = await openWallet('100.00');
    await db.sql(`UPDATE wallets SET balance = balance - 0.07 WHERE id = ?`, [wallet.id]);
    spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const reply = await reconcile(wallet.id);
    expect(reply.body).toMatchObject({
      storedBalance: money('99.93'),
      calculatedBalance: money('100.00'),
      difference: money('-0.07'),
      consistent: false,
    });
  });

  test('a divergence in one wallet does not touch the other wallets, even of the same player', async () => {
    const playerId = randomUUID();
    const broken = await openWallet('100.00', 'BRL', playerId);
    const sameCurrencyOtherPlayer = await openWallet('100.00');
    const otherCurrencySamePlayer = await openWallet('100.00', 'USD', playerId);
    await submit(payload(broken, 'BET'));
    await submit(payload(otherCurrencySamePlayer, 'BET', { money: money('10.00', 'USD'), playerId }));
    await db.sql(`UPDATE wallets SET balance = balance + 1.00 WHERE id = ?`, [broken.id]);
    spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    expect((await reconcile(broken.id)).body).toMatchObject({ consistent: false, difference: money('1.00') });
    const usd = await reconcile(otherCurrencySamePlayer.id);
    expect(usd.body).toMatchObject({ consistent: true, storedBalance: money('90.00', 'USD'), checkedEntries: 2 });
    expect((await reconcile(sameCurrencyOtherPlayer.id)).body).toMatchObject({ consistent: true, checkedEntries: 1 });
  });

  test('an entry in another currency is never summed and is always flagged, even with a zero difference', async () => {
    const wallet = await openWallet('100.00');
    // A LOSS belongs to this wallet and has no entry of its own, so it can anchor the forged entry.
    const loss = (await submit(payload(wallet, 'LOSS'))).body;
    expect(loss.status).toBe('PROCESSED');
    // Corruption simulated in this disposable database: the ledger trigger would refuse an entry for a LOSS, so
    // user triggers are switched off just for the insert. Constraints and foreign keys still accept the row.
    await db.sql(`ALTER TABLE wallet_ledger_entries DISABLE TRIGGER USER`);
    try {
      await db.sql(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, wallet_version, direction, amount, balance_before, balance_after, currency, created_at)
         VALUES (?, ?, ?, 99, 'CREDIT', 5.00, 100.00, 105.00, 'USD', now())`,
        [randomUUID(), wallet.id, loss.transactionId],
      );
    } finally {
      await db.sql(`ALTER TABLE wallet_ledger_entries ENABLE TRIGGER USER`);
    }
    const logged = spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const reply = await reconcile(wallet.id);

    expect(reply.body).toEqual({
      walletId: wallet.id,
      storedBalance: money('100.00'),
      calculatedBalance: money('100.00'),
      difference: money('0.00'),
      consistent: false,
      checkedEntries: 2,
    });
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]?.[0]).toMatchObject({ walletId: wallet.id, foreignCurrencyEntries: 1 });
  });
});

describe('POST /wallets/:walletId/reconciliation: errors', () => {
  test('an unknown wallet is 404 WALLET_NOT_FOUND', async () => {
    const reply = await reconcile(randomUUID());
    expect(reply.status).toBe(404);
    expect(reply.body.code).toBe('WALLET_NOT_FOUND');
  });

  test('a malformed wallet id is 400 INVALID_PAYLOAD, never a 500', async () => {
    for (const id of ['not-a-uuid', '123', 'a'.repeat(300)]) {
      const reply = await reconcile(id);
      expect(reply.status).toBe(400);
      expect(reply.body.code).toBe('INVALID_PAYLOAD');
    }
  });

  test('only POST is accepted', async () => {
    const wallet = await openWallet('10.00');
    expect((await call('GET', `/wallets/${wallet.id}/reconciliation`)).status).toBe(404);
  });
});

describe('POST /wallets/:walletId/reconciliation: under concurrent writes', () => {
  test('a wallet being written to in parallel always reconciles as consistent', async () => {
    const wallet = await openWallet('10000.00');
    const logged = spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const seen: boolean[] = [];

    let writing = true;
    const writers = Promise.all(
      Array.from({ length: 4 }, async (_, lane) => {
        for (let i = 0; i < 25 && writing; i++) {
          await submit(payload(wallet, i % 3 === lane % 3 ? 'WIN' : 'BET', { money: money('1.25') }));
        }
      }),
    );
    const readers = Promise.all(
      Array.from({ length: 3 }, async () => {
        while (writing) seen.push((await reconcile(wallet.id)).body.consistent);
      }),
    );
    await writers;
    writing = false;
    await readers;

    expect(seen.length).toBeGreaterThan(10);
    expect(seen.every(Boolean)).toBe(true);
    expect(logged).not.toHaveBeenCalled();
    const final = (await reconcile(wallet.id)).body;
    expect(final.consistent).toBe(true);
    expect(final.checkedEntries).toBeGreaterThan(50);
  }, 60_000);
});
