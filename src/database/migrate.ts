import { MikroORM } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { loadConfig } from '../shared/infrastructure/config';
import { migrationsList } from './migrations';

const direction = process.argv[2];
if (direction !== 'up' && direction !== 'down') {
  console.error('uso: bun run src/database/migrate.ts <up|down>');
  process.exit(2);
}

const config = loadConfig();
const orm = await MikroORM.init({
  clientUrl: config.DATABASE_URL,
  entities: [],
  discovery: { warnWhenNoEntities: false },
  extensions: [Migrator],
  migrations: { migrationsList },
  allowGlobalContext: false,
});

try {
  const done = direction === 'up' ? await orm.migrator.up() : await orm.migrator.down();
  console.log(JSON.stringify({ msg: `migration ${direction}`, applied: done.map((m) => m.name) }));
} finally {
  await orm.close(true);
}
