import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiModule } from '../../src/api.module';
import { testEnv } from './env';
import type { TestDatabase } from './test-database';

export interface Reply {
  status: number;
  body: any;
}

/**
 * Instâncias independentes da API real sobre o mesmo banco: cada uma com o próprio pool e o próprio
 * MikroORM, e nada em comum além do PostgreSQL. Rodam no mesmo processo; a prova com processos
 * separados é da Etapa 13.
 */
export interface ApiCluster {
  urls: string[];
  /** Escolhe a instância em rodízio, salvo se `instance` for informada. */
  call(method: string, path: string, body?: unknown, headers?: Record<string, string>, instance?: number): Promise<Reply>;
  close(): Promise<void>;
}

export async function startApiCluster(db: TestDatabase, size: number, overrides: Record<string, string> = {}): Promise<ApiCluster> {
  const apps: INestApplication[] = [];
  const urls: string[] = [];
  for (let i = 0; i < size; i++) {
    const app = await NestFactory.create(ApiModule.register(testEnv({ DATABASE_URL: db.url, ...overrides })), { logger: false });
    await app.listen(0);
    apps.push(app);
    urls.push(await app.getUrl());
  }
  let next = 0;
  return {
    urls,
    async call(method, path, body, headers = {}, instance) {
      const url = urls[instance ?? next++ % urls.length];
      const response = await fetch(`${url}${path}`, {
        method,
        headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : undefined };
    },
    close: async () => { await Promise.all(apps.map((app) => app.close())); },
  };
}

/** Segura o lock da wallet em outra sessão, para os testes garantirem sobreposição real. */
export interface WalletLock {
  /** Mantém a transação aberta até ser chamado; recebe o trabalho opcional a fazer antes do commit. */
  release(): Promise<void>;
}

export async function holdWalletLock(
  db: TestDatabase,
  walletId: string,
  beforeCommit: (em: any) => Promise<void> = async () => {},
): Promise<WalletLock> {
  let open!: () => void;
  const released = new Promise<void>((resolve) => { open = resolve; });
  let locked!: () => void;
  const acquired = new Promise<void>((resolve) => { locked = resolve; });
  const finished = db.orm.em.fork().transactional(async (em) => {
    await em.execute('SELECT 1 FROM wallets WHERE id = ? FOR UPDATE', [walletId]);
    locked();
    await released;
    await beforeCommit(em);
  });
  await Promise.race([acquired, finished]);
  return {
    release: async () => {
      open();
      await finished;
    },
  };
}

/**
 * Espera até `count` sessões estarem de fato esperando o lock de uma wallet: é a barreira que prova a
 * sobreposição, sem sleep fixo. Só conta sessões deste banco descartável.
 */
export async function waitForBlockedSessions(db: TestDatabase, count: number): Promise<number> {
  const deadline = Date.now() + 15_000;
  let blocked = 0;
  while (Date.now() < deadline) {
    blocked = await countBlockedSessions(db);
    if (blocked >= count) return blocked;
    await Bun.sleep(10);
  }
  throw new Error(`só ${blocked} de ${count} sessões ficaram bloqueadas no prazo`);
}

export async function countBlockedSessions(db: TestDatabase): Promise<number> {
  const [row] = await db.sql<{ blocked: number }>(
    `SELECT count(*)::int AS blocked FROM pg_stat_activity
     WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%wallets%for update%'`,
  );
  return row?.blocked ?? 0;
}
