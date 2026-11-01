import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { type INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiModule } from '../../src/api.module';
import { PERSISTENCE_SCHEMAS } from '../../src/persistence.module';
import { JsonLogger } from '../../src/shared/observability/json-logger';
import { testEnv } from '../support/env';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

// Prerequisite: `docker compose up -d postgres localstack`. The real API over real PostgreSQL, over HTTP.
// Log lines are captured from the real logger, so what is asserted is what a process would print.
let db: TestDatabase;
let app: INestApplication;
let baseUrl: string;
let lines: Array<Record<string, any>> = [];

beforeAll(async () => {
  db = await createTestDatabase({ entities: PERSISTENCE_SCHEMAS });
  await db.orm.migrator.up();
  app = await NestFactory.create(ApiModule.register(testEnv({ DATABASE_URL: db.url })), { logger: false });
  await app.listen(0);
  baseUrl = await app.getUrl();
});
afterAll(async () => {
  Logger.overrideLogger(false);
  await app.close();
  await db.drop();
});
afterEach(() => Logger.overrideLogger(false));

function captureLogs(): void {
  lines = [];
  Logger.overrideLogger(new JsonLogger({ write: (line) => lines.push(JSON.parse(line)) }, 'debug'));
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) : undefined, headers: response.headers };
}

const money = (amount: string) => ({ amount, currency: 'BRL' });
async function openWallet(amount = '100.00') {
  const reply = await call('POST', '/wallets', { playerId: randomUUID(), initialBalance: money(amount) });
  expect(reply.status).toBe(201);
  return reply.body as { id: string; playerId: string };
}
const payload = (wallet: { id: string; playerId: string }, kind: string, overrides: Record<string, unknown> = {}) => ({
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
const submit = (body: any, headers: Record<string, string> = {}) =>
  call('POST', '/wagering/transactions', body, { 'Idempotency-Key': `${body.providerId}:${body.externalTransactionId}`, ...headers });

const metricValue = async (selector: string): Promise<number> => {
  const text = (await call('GET', '/metrics')).body as string;
  const line = text.split('\n').find((candidate) => candidate.startsWith(`${selector} `));
  return line ? Number(line.slice(selector.length + 1)) : 0;
};

describe('correlation id', () => {
  test('a valid X-Correlation-Id is kept, echoed, logged and written into the outbox events', async () => {
    captureLogs();
    const wallet = await openWallet();
    const bet = payload(wallet, 'BET');
    const reply = await submit(bet, { 'X-Correlation-Id': 'order-42.attempt:1' });
    expect(reply.headers.get('x-correlation-id')).toBe('order-42.attempt:1');

    const handled = lines.find((line) => line.msg === 'transaction handled' && line.transactionId === reply.body.transactionId);
    expect(handled).toMatchObject({
      correlationId: 'order-42.attempt:1',
      walletId: wallet.id,
      providerId: 'provider-a',
      transactionId: reply.body.transactionId,
      source: 'http',
      kind: 'BET',
      status: 'PROCESSED',
      replay: false,
    });
    const events = await db.sql(`SELECT payload FROM outbox_messages WHERE payload->>'correlationId' = ?`, ['order-42.attempt:1']);
    expect(events.map((event) => event.payload.eventType).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('without the header, a new id is created and used for the response, the logs and the events', async () => {
    captureLogs();
    const wallet = await openWallet();
    const reply = await submit(payload(wallet, 'BET'));
    const correlationId = reply.headers.get('x-correlation-id')!;
    expect(correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(lines.find((line) => line.transactionId === reply.body.transactionId)?.correlationId).toBe(correlationId);
    expect((await db.sql(`SELECT 1 FROM outbox_messages WHERE payload->>'correlationId' = ?`, [correlationId])).length).toBeGreaterThan(0);
  });

  test('an unsafe header is replaced, so it can never forge a log line', async () => {
    const reply = await call('GET', '/health/live', undefined, { 'X-Correlation-Id': 'x'.repeat(500) });
    expect(reply.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('error responses carry the correlation id too', async () => {
    const reply = await call('GET', `/wallets/${randomUUID()}`, undefined, { 'X-Correlation-Id': 'trace-me' });
    expect(reply.status).toBe(404);
    expect(reply.headers.get('x-correlation-id')).toBe('trace-me');
  });
});

describe('logs of the processing result', () => {
  test('a rejection, a replay and a conflict are each logged with their outcome, and never with money', async () => {
    captureLogs();
    const wallet = await openWallet('10.00');
    const tooBig = payload(wallet, 'BET', { money: money('9999.00') });
    const rejected = await submit(tooBig);
    expect(rejected.status).toBe(422);
    const replay = await submit(tooBig);
    expect(replay.body.idempotentReplay).toBe(true);
    const conflict = await call('POST', '/wagering/transactions', payload(wallet, 'WIN', { externalTransactionId: tooBig.externalTransactionId }), {
      'Idempotency-Key': `provider-a:${tooBig.externalTransactionId}`,
    });
    expect(conflict.status).toBe(409);

    const handled = lines.filter((line) => line.msg === 'transaction handled' && line.walletId === wallet.id);
    expect(handled.map((line) => [line.status, line.failureCode ?? null, line.replay])).toEqual([
      ['REJECTED', 'INSUFFICIENT_FUNDS', false],
      ['REJECTED', 'INSUFFICIENT_FUNDS', true],
    ]);
    expect(lines.some((line) => line.level === 'warn' && String(line.msg).startsWith('idempotency conflict') && line.walletId === wallet.id)).toBe(true);

    // The whole output, for this wallet's requests, has no amount, balance or payload.
    const text = JSON.stringify(lines);
    for (const forbidden of ['9999.00', '25.00', '"amount"', '"money"', '"balance"', 'Idempotency-Key']) expect(text).not.toContain(forbidden);
  });

  test('every record of a request has the same correlation id', async () => {
    captureLogs();
    const wallet = await openWallet();
    await submit(payload(wallet, 'BET'), { 'X-Correlation-Id': 'one-request' });
    const own = lines.filter((line) => line.correlationId === 'one-request');
    expect(own.length).toBeGreaterThan(0);
    for (const line of own) expect(line.walletId ?? wallet.id).toBe(wallet.id);
  });
});

describe('GET /metrics', () => {
  test('is plain Prometheus text and lists every metric the README requires', async () => {
    const reply = await call('GET', '/metrics');
    expect(reply.status).toBe(200);
    expect(reply.headers.get('content-type')).toContain('text/plain');
    for (const name of [
      'wager_transactions_total',
      'wager_duplicates_total',
      'wager_retries_total',
      'wager_dlq_messages_total',
      'wager_lock_conflicts_total',
      'wager_wallet_lock_wait_seconds',
      'wager_processing_duration_seconds',
      'wallet_reconciliation_divergences_total',
    ]) {
      expect(reply.body as string).toContain(`# TYPE ${name} `);
    }
  });

  test('counts transactions by status, replays and idempotency conflicts as they happen', async () => {
    const wallet = await openWallet('10.00');
    const processed = 'wager_transactions_total{source="http",kind="LOSS",status="PROCESSED"}';
    const rejected = 'wager_transactions_total{source="http",kind="BET",status="REJECTED"}';
    const before = { processed: await metricValue(processed), rejected: await metricValue(rejected), replay: await metricValue('wager_duplicates_total{type="idempotent_replay"}'), conflict: await metricValue('wager_idempotency_conflicts_total') };

    await submit(payload(wallet, 'LOSS'));
    const bad = payload(wallet, 'BET', { money: money('500.00') });
    await submit(bad);
    await submit(bad);
    await call('POST', '/wagering/transactions', payload(wallet, 'WIN', { externalTransactionId: bad.externalTransactionId }), {
      'Idempotency-Key': `provider-a:${bad.externalTransactionId}`,
    });

    expect(await metricValue(processed)).toBe(before.processed + 1);
    // The replay is counted as a handled transaction too, so the original and the replay are both REJECTED.
    expect(await metricValue(rejected)).toBe(before.rejected + 2);
    expect(await metricValue('wager_duplicates_total{type="idempotent_replay"}')).toBe(before.replay + 1);
    expect(await metricValue('wager_idempotency_conflicts_total')).toBe(before.conflict + 1);
  });

  test('observes the processing latency and the wallet lock wait of every transaction', async () => {
    const wallet = await openWallet();
    const durations = 'wager_processing_duration_seconds_count{source="http"}';
    const waits = 'wager_wallet_lock_wait_seconds_count';
    const before = { durations: await metricValue(durations), waits: await metricValue(waits) };
    await Promise.all(Array.from({ length: 5 }, () => submit(payload(wallet, 'LOSS'))));
    expect(await metricValue(durations)).toBe(before.durations + 5);
    expect(await metricValue(waits)).toBe(before.waits + 5);
    expect(await metricValue('wager_processing_duration_seconds_sum{source="http"}')).toBeGreaterThan(0);
  });

  test('counts a reconciliation divergence', async () => {
    const wallet = await openWallet();
    const before = await metricValue('wallet_reconciliation_divergences_total');
    await db.sql(`UPDATE wallets SET balance = balance + 1.00 WHERE id = ?`, [wallet.id]);
    captureLogs();
    expect((await call('POST', `/wallets/${wallet.id}/reconciliation`)).body.consistent).toBe(false);
    expect(await metricValue('wallet_reconciliation_divergences_total')).toBe(before + 1);
    expect(lines.find((line) => line.msg === 'reconciliation divergence detected')).toMatchObject({ level: 'error', walletId: wallet.id, difference: '1.00 BRL' });
  });

  test('exposes no wallet identifier, amount or secret in any label', async () => {
    const wallet = await openWallet('77.77');
    await submit(payload(wallet, 'BET', { money: money('12.34') }));
    const text = (await call('GET', '/metrics')).body as string;
    for (const forbidden of [wallet.id, wallet.playerId, '77.77', '12.34', 'postgres://', 'secret']) expect(text).not.toContain(forbidden);
  });
});
