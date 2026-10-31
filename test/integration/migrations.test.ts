import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { migrationsList } from '../../src/database/migrations';
import { createTestDatabase, schemaObjects, type TestDatabase } from '../support/test-database';

// Pré-requisito: `docker compose up -d postgres`. Cada teste usa um banco PostgreSQL descartável próprio,
// para não depender da ordem de execução.
const TABLES = ['inbox_messages', 'outbox_messages', 'wager_transactions', 'wallet_ledger_entries', 'wallets'];
const ROOT = `${import.meta.dir}/../..`;

describe('migrations em um banco limpo', () => {
  let db: TestDatabase;
  beforeEach(async () => { db = await createTestDatabase(); });
  afterEach(async () => { await db.drop(); });

  test('banco novo: todas pendentes e nenhuma tabela', async () => {
    const pending = await db.orm.migrator.getPending();
    expect(pending.map((m) => m.name)).toEqual(migrationsList.map((m) => m.name));
    expect((await schemaObjects(db)).tables).toEqual([]);
  });

  test('up cria o schema esperado; a tabela do spike não sobrevive', async () => {
    await db.orm.migrator.up();
    const objects = await schemaObjects(db);
    expect(objects.tables).toEqual(TABLES);
    expect(objects.triggers).toEqual([
      'ledger_guard_insert',
      'ledger_immutable_rows',
      'ledger_immutable_truncate',
      'wager_tx_guard_change',
    ]);
    expect(objects.functions).toEqual([
      'forbid_ledger_mutation',
      'guard_ledger_insert',
      'guard_wager_transaction_change',
    ]);
    for (const index of ['wager_tx_single_reversal', 'wager_tx_pending_due', 'ledger_wallet_seq', 'outbox_pending_due']) {
      expect(objects.indexes).toContain(index);
    }
    expect(await db.orm.migrator.getPending()).toEqual([]);
  });

  test('colunas de dinheiro são NUMERIC(20,2); nenhuma coluna usa ponto flutuante', async () => {
    await db.orm.migrator.up();
    const columns = await db.sql(`
      SELECT table_name || '.' || column_name AS name, data_type, numeric_precision, numeric_scale
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name <> 'mikro_orm_migrations'`);
    expect(columns.filter((c) => ['real', 'double precision', 'money'].includes(c.data_type))).toEqual([]);
    const money = columns.filter((c) => c.data_type === 'numeric');
    expect(money.map((c) => c.name).sort()).toEqual([
      'wager_transactions.amount',
      'wager_transactions.observed_balance',
      'wallet_ledger_entries.amount',
      'wallet_ledger_entries.balance_after',
      'wallet_ledger_entries.balance_before',
      'wallets.balance',
    ]);
    for (const column of money) {
      expect(column.numeric_precision).toBe(20);
      expect(column.numeric_scale).toBe(2);
    }
  });

  test('índice parcial de reversão é único e restrito a reversões aplicadas', async () => {
    await db.orm.migrator.up();
    const [index] = await db.sql(`SELECT indexdef FROM pg_indexes WHERE indexname = 'wager_tx_single_reversal'`);
    expect(index?.indexdef).toContain('UNIQUE');
    expect(index?.indexdef).toContain('REFUND');
    expect(index?.indexdef).toContain('ROLLBACK');
    expect(index?.indexdef).toContain('PROCESSED');
  });

  test('down de tudo remove todos os objetos; up recria um schema idêntico', async () => {
    await db.orm.migrator.up();
    const before = await schemaObjects(db);
    await db.orm.migrator.down({ to: 0 });
    expect(await schemaObjects(db)).toEqual({ tables: [], indexes: [], constraints: [], triggers: [], functions: [] });

    await db.orm.migrator.up();
    expect(await schemaObjects(db)).toEqual(before);
  });

  test('cada migration é reversível isoladamente, da última à primeira', async () => {
    await db.orm.migrator.up();
    const states: Awaited<ReturnType<typeof schemaObjects>>[] = [];
    for (let i = 0; i < migrationsList.length; i++) {
      states.push(await schemaObjects(db));
      await db.orm.migrator.down();
    }
    expect((await schemaObjects(db)).tables).toEqual([]);

    for (let i = migrationsList.length - 1; i >= 0; i--) {
      await db.orm.migrator.up({ to: migrationsList[migrationsList.length - 1 - i]!.name });
      expect(await schemaObjects(db)).toEqual(states[i]!);
    }
  });
});

describe('script de migração real (bun run src/database/migrate.ts)', () => {
  let db: TestDatabase;
  beforeEach(async () => { db = await createTestDatabase(); });
  afterEach(async () => { await db.drop(); });

  const migrate = async (direction: string) => {
    const proc = Bun.spawn(['bun', 'run', 'src/database/migrate.ts', direction], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: db.url },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { stdout, code };
  };

  test('up aplica todas; repetir é seguro; down reverte só a última', async () => {
    const first = await migrate('up');
    expect(first.code).toBe(0);
    expect((await schemaObjects(db)).tables).toEqual(TABLES);

    const again = await migrate('up');
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('"applied":[]');

    const down = await migrate('down');
    expect(down.code).toBe(0);
    expect(down.stdout).toContain('Migration20261031000007_create_integrity_triggers');
    expect((await schemaObjects(db)).triggers).toEqual([]);
    expect((await schemaObjects(db)).tables).toEqual(TABLES);
  });

  test('direção inválida falha sem tocar no banco', async () => {
    expect((await migrate('sideways')).code).toBe(2);
  });

  test('migrar não deixa arquivo de snapshot no projeto', async () => {
    expect((await migrate('up')).code).toBe(0);
    expect((await migrate('down')).code).toBe(0);
    expect(readdirSync(ROOT, { recursive: true, encoding: 'utf8' }).filter((path) => path.includes(db.name))).toEqual([]);
  });
});
