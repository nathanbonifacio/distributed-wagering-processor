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

test('ok quando todas as dependências respondem', async () => {
  const report = await service([probe('a', async () => {}), probe('b', async () => {})]).checkReadiness();
  expect(report.status).toBe('ok');
  expect(report.checks.a!.status).toBe('up');
  expect(report.checks.b!.status).toBe('up');
});

test('unavailable quando uma dependência rejeita, e as demais continuam reportadas', async () => {
  spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  const report = await service([
    probe('a', async () => {}),
    probe('b', async () => { throw new Error('connection refused'); }),
  ]).checkReadiness();
  expect(report.status).toBe('unavailable');
  expect(report.checks.a!.status).toBe('up');
  expect(report.checks.b).toMatchObject({ status: 'down', reason: 'unavailable' });
});

test('dependência que trava estoura o prazo, aborta o signal e reporta reason=timeout', async () => {
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

test('as verificações rodam em paralelo (tempo total ~ o da mais lenta)', async () => {
  const wait = (ms: number) => probe(`w${ms}`, () => Bun.sleep(ms));
  const started = performance.now();
  await service([wait(150), wait(150), wait(150)], 1000).checkReadiness();
  expect(performance.now() - started).toBeLessThan(400);
});

test('a resposta pública não vaza a mensagem do erro interno nem credenciais', async () => {
  spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  const report = await service([
    probe('db', async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:5432 postgres://app:s3cret@db.internal/prod'); }),
  ]).checkReadiness();
  const json = JSON.stringify(report);
  for (const leak of ['ECONNREFUSED', '10.0.0.5', 's3cret', 'db.internal', 'postgres://']) {
    expect(json).not.toContain(leak);
  }
});

test('o diagnóstico vai para o log interno, com a URL redigida', async () => {
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

test('chamadas concorrentes compartilham uma única verificação em andamento (sem acúmulo)', async () => {
  let calls = 0;
  const slow = probe('slow', async () => { calls++; await Bun.sleep(80); });
  const svc = service([slow], 1000);
  const reports = await Promise.all(Array.from({ length: 10 }, () => svc.checkReadiness()));
  expect(calls).toBe(1);
  expect(reports.every((r) => r.status === 'ok')).toBe(true);

  await svc.checkReadiness(); // terminada a anterior, uma nova chamada verifica de novo
  expect(calls).toBe(2);
});

test('withTimeout devolve o valor quando o trabalho termina no prazo', async () => {
  expect(await withTimeout(async () => 42, 100)).toBe(42);
});
