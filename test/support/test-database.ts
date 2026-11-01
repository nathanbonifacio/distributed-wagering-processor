import { randomUUID } from 'node:crypto';
import { Migrator } from '@mikro-orm/migrations';
import { type EntitySchema, MikroORM } from '@mikro-orm/postgresql';
import { migrationsList } from '../../src/database/migrations';
import { testEnv } from './env';

const PREFIX = 'wagering_test_';

export interface TestDatabase {
  url: string;
  name: string;
  orm: MikroORM;
  sql<T = Record<string, any>>(query: string, params?: unknown[]): Promise<T[]>;
  drop(): Promise<void>;
}

function adminOrm(): MikroORM {
  return new MikroORM({
    clientUrl: testEnv().DATABASE_URL,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    allowGlobalContext: false,
  });
}

/**
 * Banco PostgreSQL real e descartável, criado do zero: nada do que um teste faz alcança o banco de
 * desenvolvimento. Só apaga bancos com o prefixo próprio dos testes.
 */
export async function createTestDatabase(options: {
  migrations?: typeof migrationsList;
  entities?: EntitySchema<any>[];
} = {}): Promise<TestDatabase> {
  const name = `${PREFIX}${randomUUID().replaceAll('-', '')}`;
  const admin = adminOrm();
  await admin.em.fork().getConnection().execute(`CREATE DATABASE "${name}"`);

  const url = new URL(testEnv().DATABASE_URL!);
  url.pathname = `/${name}`;
  const orm = new MikroORM({
    clientUrl: url.toString(),
    entities: options.entities ?? [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: { migrationsList: options.migrations ?? migrationsList, silent: true, snapshot: false },
    allowGlobalContext: false,
  });

  return {
    url: url.toString(),
    name,
    orm,
    sql: (query, params) => orm.em.fork().getConnection().execute(query, (params ?? []) as any[]) as Promise<any[]>,
    drop: async () => {
      await orm.close(true);
      if (!name.startsWith(PREFIX)) throw new Error(`refusing to drop database ${name}`);
      await admin.em.fork().getConnection().execute(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.close(true);
    },
  };
}

/** Nomes dos objetos do schema public, para comparar o banco antes e depois das migrations. */
export async function schemaObjects(db: TestDatabase) {
  const names = (rows: Array<{ name: string }>) => rows.map((row) => row.name).sort();
  return {
    tables: names(await db.sql(`SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'mikro_orm_migrations'`)),
    indexes: names(await db.sql(`SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public' AND tablename <> 'mikro_orm_migrations'`)),
    constraints: names(await db.sql(`SELECT c.conname AS name FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public' AND t.relname <> 'mikro_orm_migrations' AND c.contype <> 'n'`)),
    triggers: names(await db.sql(`SELECT tgname AS name FROM pg_trigger WHERE NOT tgisinternal`)),
    functions: names(await db.sql(`SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`)),
  };
}
