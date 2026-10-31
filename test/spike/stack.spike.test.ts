import 'reflect-metadata';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Controller, Get, Inject, Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { EntitySchema, LockMode, type MikroORM } from '@mikro-orm/postgresql';
import Decimal from 'decimal.js';
import { Migration20260101000001_spike } from '../../src/database/migrations/Migration20260101000001_spike';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

interface SpikeWalletRow { id: string; balance: string; version: number }
const SpikeWallet = new EntitySchema<SpikeWalletRow>({
  name: 'SpikeWallet',
  tableName: 'spike_wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    balance: { type: 'string', columnType: 'numeric(20,2)' },
    version: { type: 'number', columnType: 'integer' },
  },
});

@Injectable()
class Dep { hello() { return 'ok'; } }

@Controller('ping')
class PingController {
  constructor(@Inject(Dep) private readonly dep: Dep, private readonly typed: Dep) {}
  @Get() ping() { return { dep: this.dep.hello(), typed: this.typed.hello() }; }
}

@Module({ controllers: [PingController], providers: [Dep] })
class SpikeModule {}

let orm: MikroORM;
let db: TestDatabase;

// Banco descartável com só a migration do spike: a tabela não existe mais no schema real.
beforeAll(async () => {
  db = await createTestDatabase({
    entities: [SpikeWallet],
    migrations: [{ name: 'Migration20260101000001_spike', class: Migration20260101000001_spike }],
  });
  orm = db.orm;
});
afterAll(async () => { await db.drop(); });

test('Nest: DI por tipo (emitDecoratorMetadata) e HTTP funcionam sob Bun', async () => {
  const app = await NestFactory.create(SpikeModule, { logger: false });
  await app.listen(0);
  const url = await app.getUrl();
  const body = await (await fetch(`${url}/ping`)).json();
  await app.close();
  expect(body).toEqual({ dep: 'ok', typed: 'ok' });
});

test('MikroORM: migration up/down/up programática com migrationsList', async () => {
  const m = orm.migrator;
  await m.up();
  await m.down();
  const gone = await orm.em.fork().getConnection().execute(`select to_regclass('spike_wallets') as t`);
  expect(gone[0]!.t).toBeNull();
  await m.up();
  const there = await orm.em.fork().getConnection().execute(`select to_regclass('spike_wallets') as t`);
  expect(there[0]!.t).toBe('spike_wallets');
});

test('MikroORM: FOR UPDATE serializa duas transações na mesma linha (numeric volta como string)', async () => {
  const id = crypto.randomUUID();
  await orm.em.fork().getConnection().execute(`insert into spike_wallets values ('${id}', '100.00', 1)`);

  const spend = async (amount: string) => orm.em.fork().transactional(async (em) => {
    const w = await em.findOneOrFail(SpikeWallet, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    await Bun.sleep(150);
    const amt = new Decimal(amount);
    if (new Decimal(w.balance).lt(amt)) return 'REJECTED';
    w.balance = new Decimal(w.balance).minus(amt).toFixed(2);
    w.version += 1;
    return 'PROCESSED';
  });

  const results = await Promise.all([spend('80.00'), spend('80.00')]);
  const row = (await orm.em.fork().getConnection().execute(`select balance, version from spike_wallets where id='${id}'`))[0]!;
  expect(results.sort()).toEqual(['PROCESSED', 'REJECTED']);
  expect(row.balance).toBe('20.00');
  expect(row.version).toBe(2);
  expect(typeof row.balance).toBe('string');
});
