import 'reflect-metadata';
import { afterAll, describe, expect, test } from 'bun:test';
import { type INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HealthModule } from '../../src/health/health.module';
import { ConfigModule } from '../../src/shared/infrastructure/config.module';
import { testEnv, withHostPort } from '../support/env';
import { startBlackhole, startTcpProxy } from '../support/tcp-proxy';

// Pré-requisito: `docker compose up -d postgres localstack`.
// Cada app recebe sua configuração por ConfigModule.register(): nenhum teste muta process.env.
// "Indisponível" é real: porta onde nada escuta (127.0.0.1:1), proxy derrubado ou serviço pendurado.
const UNREACHABLE = { host: '127.0.0.1', port: 1 };

describe('GET /health (PostgreSQL e LocalStack reais)', () => {
  const apps: INestApplication[] = [];
  const cleanups: Array<() => Promise<void>> = [];

  async function start(overrides: Record<string, string> = {}) {
    @Module({ imports: [ConfigModule.register(testEnv(overrides)), HealthModule] })
    class TestAppModule {}
    const app = await NestFactory.create(TestAppModule, { logger: false });
    await app.listen(0);
    apps.push(app);
    const url = await app.getUrl();
    return async (path: string) => {
      const res = await fetch(`${url}${path}`);
      return { status: res.status, body: (await res.json()) as any };
    };
  }

  afterAll(async () => {
    await Promise.all(apps.map((a) => a.close()));
    await Promise.all(cleanups.map((c) => c()));
  });

  const pgUrl = (host: string, port: number) => withHostPort(testEnv().DATABASE_URL!, host, port);

  test('ready: 200 com PostgreSQL, fila de entrada e fila de eventos acessíveis', async () => {
    const get = await start();
    const { status, body } = await get('/health/ready');
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(Object.keys(body.checks).sort()).toEqual(['postgres', 'sqs', 'sqsEvents']);
    for (const check of Object.values<any>(body.checks)) expect(check.status).toBe('up');
  });

  test('ready: 503 quando só a fila de eventos não existe (as demais seguem up)', async () => {
    const get = await start({ SQS_EVENTS_QUEUE_NAME: 'wager-events-que-nao-existe' });
    const { status, body } = await get('/health/ready');
    expect(status).toBe(503);
    expect(body.checks.sqsEvents.status).toBe('down');
    expect(body.checks.sqs.status).toBe('up');
    expect(body.checks.postgres.status).toBe('up');
  });

  test('ready: 503 quando só a fila de entrada não existe (as demais seguem up)', async () => {
    const get = await start({ SQS_INPUT_QUEUE_NAME: 'wager-input-que-nao-existe.fifo' });
    const { status, body } = await get('/health/ready');
    expect(status).toBe(503);
    expect(body.checks.sqs.status).toBe('down');
    expect(body.checks.sqsEvents.status).toBe('up');
    expect(body.checks.postgres.status).toBe('up');
  });

  test('ready: 503 quando o PostgreSQL está indisponível (SQS segue up)', async () => {
    const get = await start({ DATABASE_URL: pgUrl(UNREACHABLE.host, UNREACHABLE.port) });
    const { status, body } = await get('/health/ready');
    expect(status).toBe(503);
    expect(body.checks.postgres.status).toBe('down');
    expect(body.checks.sqs.status).toBe('up');
    expect(body.checks.sqsEvents.status).toBe('up');
  });

  test('ready: 503 quando o SQS inteiro está indisponível (PostgreSQL segue up)', async () => {
    const get = await start({ SQS_ENDPOINT: `http://${UNREACHABLE.host}:${UNREACHABLE.port}` });
    const { status, body } = await get('/health/ready');
    expect(status).toBe(503);
    expect(body.checks.sqs.status).toBe('down');
    expect(body.checks.sqsEvents.status).toBe('down');
    expect(body.checks.postgres.status).toBe('up');
  });

  test('ready: recupera sozinho quando o PostgreSQL cai e volta (200 → 503 → 200)', async () => {
    const real = new URL(testEnv().DATABASE_URL!);
    const proxy = await startTcpProxy({ host: real.hostname, port: Number(real.port || 5432) });
    cleanups.push(() => proxy.close());
    const get = await start({ DATABASE_URL: pgUrl('127.0.0.1', proxy.port) });

    expect((await get('/health/ready')).status).toBe(200);

    await proxy.close();
    const down = await get('/health/ready');
    expect(down.status).toBe(503);
    expect(down.body.checks.postgres.status).toBe('down');
    expect((await get('/health/live')).status).toBe(200); // liveness não depende do banco

    await proxy.open();
    const recovered = await get('/health/ready');
    expect(recovered.status).toBe(200);
    expect(recovered.body.checks.postgres.status).toBe('up');
  });

  test('ready: PostgreSQL pendurado vira 503 dentro do prazo, com reason=timeout', async () => {
    const hole = await startBlackhole();
    cleanups.push(() => hole.close());
    const get = await start({ DATABASE_URL: pgUrl('127.0.0.1', hole.port), HEALTH_CHECK_TIMEOUT_MS: '500' });

    const started = performance.now();
    const { status, body } = await get('/health/ready');
    expect(performance.now() - started).toBeLessThan(3000);
    expect(status).toBe(503);
    expect(body.checks.postgres).toMatchObject({ status: 'down', reason: 'timeout' });
  });

  test('ready: a resposta pública não expõe erros de driver, hosts, portas nem credenciais', async () => {
    const get = await start({
      DATABASE_URL: pgUrl(UNREACHABLE.host, UNREACHABLE.port),
      SQS_ENDPOINT: `http://${UNREACHABLE.host}:${UNREACHABLE.port}`,
    });
    const res = await get('/health/ready');
    expect(res.status).toBe(503);
    const text = JSON.stringify(res.body);
    for (const leak of ['ECONNREFUSED', '127.0.0.1', ':1/', 'wagering', 'password', 'postgres://']) {
      expect(text).not.toContain(leak);
    }
  });

  test('live: 200 mesmo com todas as dependências fora (liveness não olha dependências)', async () => {
    const get = await start({
      DATABASE_URL: pgUrl(UNREACHABLE.host, UNREACHABLE.port),
      SQS_ENDPOINT: `http://${UNREACHABLE.host}:${UNREACHABLE.port}`,
    });
    const { status, body } = await get('/health/live');
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ok' });
  });

  test('ready: não exige autenticação (nenhum header enviado)', async () => {
    const get = await start();
    expect((await get('/health/ready')).status).toBe(200);
  });
});
