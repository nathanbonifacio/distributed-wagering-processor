import 'reflect-metadata';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { Logger } from '@nestjs/common';
import type { DependencyProbe } from '../../src/app/health/dependency-probe';
import { HealthService } from '../../src/app/health/health.service';
import { withTimeout } from '../../src/shared/infrastructure/with-timeout';

const probe = (name: string, check: DependencyProbe['check']): DependencyProbe => ({ name, check });
const service = (probes: DependencyProbe[], timeoutMs = 100) =>
  new HealthService(probes, { HEALTH_CHECK_TIMEOUT_MS: timeoutMs });

afterEach(() => { spyOn(Logger.prototype, 'warn').mockRestore(); });

test('ok when every dependency responds', async () => {
  const report = await service([probe('a', async () => {}), probe('b', async () => {})]).checkReadiness();
  expect(report.status).toBe('ok');
  expect(report.checks.a!.status).toBe('up');
  expect(report.checks.b!.status).toBe('up');
});

test('unavailable when one dependency rejects, and the others are still reported', async () => {
  spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  const report = await service([
    probe('a', async () => {}),
    probe('b', async () => { throw new Error('connection refused'); }),
  ]).checkReadiness();
  expect(report.status).toBe('unavailable');
  expect(report.checks.a!.status).toBe('up');
  expect(report.checks.b).toMatchObject({ status: 'down', reason: 'unavailable' });
});

test('a dependency that hangs hits the deadline, aborts the signal and reports reason=timeout', async () => {
  spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  let aborted = false;
  const hanging = probe('slow', (signal) => new Promise<void>(() => {
    signal.addEventListener('abort', () => { aborted = true; });
  }));
  const started = performance.now();
  const report = await service([hanging], 50).checkReadiness();
  expect(performance.now() - started).toBeLessThan(1000);
  expect(report.status).toBe('unavailable');
  expect(report.checks.slow).toMatchObject({ status: 'down', reason: 'timeout' });
  expect(aborted).toBe(true);
});

test('the checks run in parallel (total time ~ that of the slowest)', async () => {
  const wait = (ms: number) => probe(`w${ms}`, () => Bun.sleep(ms));
  const started = performance.now();
  await service([wait(150), wait(150), wait(150)], 1000).checkReadiness();
  expect(performance.now() - started).toBeLessThan(400);
});

test('the public response does not leak the internal error message or credentials', async () => {
  spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  const report = await service([
    probe('db', async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:5432 postgres://app:s3cret@db.internal/prod'); }),
  ]).checkReadiness();
  const json = JSON.stringify(report);
  for (const leak of ['ECONNREFUSED', '10.0.0.5', 's3cret', 'db.internal', 'postgres://']) {
    expect(json).not.toContain(leak);
  }
});

test('the diagnosis goes to the internal log, with the URL redacted', async () => {
  const warn = spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  await service([
    probe('db', async () => { throw new Error('connect ECONNREFUSED postgres://app:s3cret@db.internal/prod'); }),
  ]).checkReadiness();
  expect(warn).toHaveBeenCalledTimes(1);
  const logged = JSON.stringify(warn.mock.calls[0]);
  expect(logged).toContain('db');
  expect(logged).toContain('ECONNREFUSED');
  expect(logged).not.toContain('s3cret');
});

test('concurrent calls share a single check in flight (no pile-up)', async () => {
  let calls = 0;
  const slow = probe('slow', async () => { calls++; await Bun.sleep(80); });
  const svc = service([slow], 1000);
  const reports = await Promise.all(Array.from({ length: 10 }, () => svc.checkReadiness()));
  expect(calls).toBe(1);
  expect(reports.every((r) => r.status === 'ok')).toBe(true);

  await svc.checkReadiness(); // terminada a anterior, uma nova chamada verifica de novo
  expect(calls).toBe(2);
});

test('withTimeout returns the value when the work finishes in time', async () => {
  expect(await withTimeout(async () => 42, 100)).toBe(42);
});
