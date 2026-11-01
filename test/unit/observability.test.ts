import { describe, expect, test } from 'bun:test';
import { Logger } from '@nestjs/common';
import type { WagerHandled } from '../../src/app/wagering/application/ports/wager-telemetry.port';
import { FailureCode } from '../../src/app/wagering/domain/failure-code';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/app/wagering/domain/wager-transaction.entity';
import { ObservedWagerTelemetry } from '../../src/app/wagering/infrastructure/wager-telemetry';
import { currentContext, enrichContext, runWithContext } from '../../src/shared/application/request-context';
import { AppMetrics } from '../../src/shared/observability/app-metrics';
import { JsonLogger } from '../../src/shared/observability/json-logger';
import { CorrelationMiddleware } from '../../src/shared/presentation/correlation.middleware';

function capture(level: 'debug' | 'trace' = 'debug') {
  const lines: Array<Record<string, any>> = [];
  const logger = new JsonLogger({ write: (line) => lines.push(JSON.parse(line)) }, level);
  return { lines, logger };
}

describe('JsonLogger', () => {
  test('writes one JSON object per record with level, ISO time, message and the Nest class name', () => {
    const { lines, logger } = capture();
    logger.log('server started', 'Bootstrap');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'info', msg: 'server started', context: 'Bootstrap' });
    expect(new Date(lines[0]!.time).toISOString()).toBe(lines[0]!.time);
    expect(lines[0]).not.toHaveProperty('pid');
    expect(lines[0]).not.toHaveProperty('hostname');
  });

  test('maps each Nest level to a level name', () => {
    const { lines, logger } = capture('trace');
    logger.error('e');
    logger.warn('w');
    logger.debug('d');
    logger.verbose('v');
    logger.fatal('f');
    expect(lines.map((line) => line.level)).toEqual(['error', 'warn', 'debug', 'trace', 'fatal']);
  });

  test('adds the request context fields to every record, and explicit fields win', () => {
    const { lines, logger } = capture();
    runWithContext({ correlationId: 'corr-1', messageId: 'msg-1', walletId: 'wallet-1', providerId: 'provider-a' }, () => {
      enrichContext({ transactionId: 'tx-1' });
      logger.log({ msg: 'handled' });
      logger.log({ msg: 'override', providerId: 'provider-b' });
    });
    expect(lines[0]).toMatchObject({
      msg: 'handled',
      correlationId: 'corr-1',
      messageId: 'msg-1',
      transactionId: 'tx-1',
      walletId: 'wallet-1',
      providerId: 'provider-a',
    });
    expect(lines[1]?.providerId).toBe('provider-b');
  });

  test('records outside any context have no context fields', () => {
    const { lines, logger } = capture();
    logger.log({ msg: 'plain' });
    expect(Object.keys(lines[0]!).sort()).toEqual(['level', 'msg', 'time']);
  });

  test('concurrent contexts never leak into each other', async () => {
    const { lines, logger } = capture();
    await Promise.all(
      ['a', 'b', 'c', 'd'].map((id, index) =>
        runWithContext({ correlationId: id }, async () => {
          await Bun.sleep(4 - index);
          logger.log({ msg: 'step', expected: id });
        }),
      ),
    );
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(line.correlationId).toBe(line.expected);
  });

  test('redacts monetary and secret fields even when a caller logs them by mistake, at any depth', () => {
    const { lines, logger } = capture();
    logger.log({
      msg: 'oops',
      money: { amount: '25.00', currency: 'BRL' },
      balance: '975.00',
      payload: { providerId: 'x' },
      nested: { amount: '9.99', balanceAfter: '1.00', token: 'abc', password: 'p' },
      authorization: 'Bearer abc',
    });
    const text = JSON.stringify(lines[0]);
    for (const secret of ['25.00', '975.00', '9.99', 'Bearer', 'abc', '"p"']) expect(text).not.toContain(secret);
    expect(lines[0]).toMatchObject({ money: '[redacted]', balance: '[redacted]', payload: '[redacted]', authorization: '[redacted]' });
    expect(lines[0]?.nested).toMatchObject({ amount: '[redacted]', balanceAfter: '[redacted]', token: '[redacted]', password: '[redacted]' });
  });

  test('an Error is logged by name only, with no message and no stack trace', () => {
    const { lines, logger } = capture();
    logger.error(new Error('SELECT * FROM wallets WHERE balance = 12.34'));
    const text = JSON.stringify(lines[0]);
    expect(lines[0]?.msg).toBe('Error');
    expect(text).not.toContain('SELECT');
    expect(text).not.toContain('12.34');
    expect(text).not.toContain('stack');
  });

  test('a message with newlines stays a single JSON line', () => {
    const lines: string[] = [];
    new JsonLogger({ write: (line) => lines.push(line) }).log('first\nsecond');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(lines[0]!).msg).toBe('first\nsecond');
  });
});

describe('CorrelationMiddleware', () => {
  const run = (header?: string | string[]) => {
    const headers: Record<string, string> = {};
    let inside: string | undefined;
    new CorrelationMiddleware().use(
      { headers: header === undefined ? {} : { 'x-correlation-id': header } },
      { setHeader: (name, value) => { headers[name] = value; } },
      () => { inside = currentContext().correlationId; },
    );
    return { headers, inside };
  };

  test('keeps a valid id from the caller, echoes it and exposes it to the handler', () => {
    const { headers, inside } = run('order-42.retry:3');
    expect(headers['X-Correlation-Id']).toBe('order-42.retry:3');
    expect(inside).toBe('order-42.retry:3');
  });

  test('creates a new id when there is none', () => {
    const { headers, inside } = run();
    expect(headers['X-Correlation-Id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(inside).toBe(headers['X-Correlation-Id']);
  });

  test.each([
    ['a value with a line break', 'abc\nfake log line'],
    ['a value with spaces', 'a b'],
    ['a value that is too long', 'x'.repeat(129)],
    ['an empty value', ''],
    ['a repeated header', ['a', 'b']],
  ])('replaces %s with a new id instead of trusting it', (_, value) => {
    const { headers } = run(value);
    expect(headers['X-Correlation-Id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('AppMetrics', () => {
  const REQUIRED = [
    'wager_transactions_total',
    'wager_duplicates_total',
    'wager_retries_total',
    'wager_dlq_messages_total',
    'wager_lock_conflicts_total',
    'wager_wallet_lock_wait_seconds',
    'wager_processing_duration_seconds',
    'wallet_reconciliation_divergences_total',
  ];

  test('exposes every metric the README requires, in the Prometheus text format', async () => {
    const metrics = new AppMetrics();
    metrics.gauge('wager_outbox_lag_seconds', 'lag', async () => 12.5);
    const text = await metrics.render();
    for (const name of [...REQUIRED, 'wager_outbox_lag_seconds']) expect(text).toContain(`# TYPE ${name} `);
    expect(text).toContain('wager_outbox_lag_seconds 12.5');
  });

  test('registries are independent, so one process or test never sees another one', async () => {
    const a = new AppMetrics();
    const b = new AppMetrics();
    a.dlqMessages.inc({ reason: 'INVALID_MESSAGE' });
    expect(await a.render()).toContain('wager_dlq_messages_total{reason="INVALID_MESSAGE"} 1');
    expect(await b.render()).not.toContain('INVALID_MESSAGE');
  });

  test('a gauge that cannot be read does not break the other metrics', async () => {
    const metrics = new AppMetrics();
    metrics.gauge('wager_broken', 'always fails', async () => {
      throw new Error('database is down');
    });
    metrics.retries.inc({ kind: 'sqs_redelivery' });
    const text = await metrics.render();
    expect(text).toContain('wager_retries_total{kind="sqs_redelivery"} 1');
    expect(text).not.toContain('database is down');
  });
});

describe('ObservedWagerTelemetry', () => {
  const handled = (overrides: Partial<WagerHandled> = {}): WagerHandled => ({
    source: 'http',
    kind: WagerTransactionKind.Bet,
    status: WagerTransactionStatus.Processed,
    replay: false,
    durationMs: 12.6,
    transactionId: 'tx-1',
    walletId: 'wallet-1',
    providerId: 'provider-a',
    ...overrides,
  });

  function build() {
    const metrics = new AppMetrics();
    const { lines, logger } = capture();
    Logger.overrideLogger(logger);
    return { metrics, lines, telemetry: new ObservedWagerTelemetry(metrics), done: () => Logger.overrideLogger(false) };
  }

  test('counts the transaction by source, kind and status, observes the duration and logs only identifiers', async () => {
    const { metrics, lines, telemetry, done } = build();
    try {
      runWithContext({ correlationId: 'corr-1' }, () => telemetry.handled(handled()));
    } finally {
      done();
    }
    const text = await metrics.render();
    expect(text).toContain('wager_transactions_total{source="http",kind="BET",status="PROCESSED"} 1');
    expect(text).toContain('wager_processing_duration_seconds_count{source="http"} 1');
    expect(text).toContain('wager_processing_duration_seconds_sum{source="http"} 0.0126');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      msg: 'transaction handled',
      correlationId: 'corr-1',
      transactionId: 'tx-1',
      walletId: 'wallet-1',
      providerId: 'provider-a',
      status: 'PROCESSED',
      replay: false,
      durationMs: 13,
    });
  });

  test('a replay also counts as a detected duplicate', async () => {
    const { metrics, telemetry, done } = build();
    try {
      telemetry.handled(handled({ replay: true }));
    } finally {
      done();
    }
    expect(await metrics.render()).toContain('wager_duplicates_total{type="idempotent_replay"} 1');
  });

  test('a rejection carries its failure code, and a FAILED transaction is logged as an error', () => {
    const { lines, telemetry, done } = build();
    try {
      telemetry.handled(handled({ status: WagerTransactionStatus.Rejected, failureCode: FailureCode.InsufficientFunds }));
      telemetry.handled(handled({ status: WagerTransactionStatus.Failed, failureCode: FailureCode.InternalError }));
    } finally {
      done();
    }
    expect(lines[0]).toMatchObject({ level: 'info', status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
    expect(lines[1]).toMatchObject({ level: 'error', status: 'FAILED', failureCode: 'INTERNAL_ERROR' });
  });

  test('duplicate messages, conflicts, collisions and rescheduled references each have their own counter', async () => {
    const { metrics, lines, telemetry, done } = build();
    try {
      telemetry.duplicateMessage({ consumerName: 'c', messageId: 'm-1', walletId: 'w', providerId: 'p' });
      telemetry.idempotencyConflict({ walletId: 'w', providerId: 'p' });
      telemetry.uniqueCollision({ walletId: 'w', providerId: 'p' });
      telemetry.referenceRescheduled({ transactionId: 't', walletId: 'w', providerId: 'p', attempts: 2 });
    } finally {
      done();
    }
    const text = await metrics.render();
    expect(text).toContain('wager_duplicates_total{type="inbox_message"} 1');
    expect(text).toContain('wager_idempotency_conflicts_total 1');
    expect(text).toContain('wager_lock_conflicts_total{type="unique_collision"} 1');
    expect(text).toContain('wager_retries_total{kind="pending_reference"} 1');
    expect(lines.map((line) => line.level)).toEqual(['info', 'warn', 'info', 'info']);
    expect(lines[0]).toMatchObject({ messageId: 'm-1', consumerName: 'c' });
  });

  test('the lock wait is always measured, but only a notable wait is logged', async () => {
    const { metrics, lines, telemetry, done } = build();
    try {
      telemetry.walletLockAcquired({ walletId: 'w', waitedMs: 3 });
      telemetry.walletLockAcquired({ walletId: 'w', waitedMs: 450 });
    } finally {
      done();
    }
    expect(await metrics.render()).toContain('wager_wallet_lock_wait_seconds_count 2');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ msg: 'waited for the wallet lock', walletId: 'w', waitedMs: 450 });
  });
});
