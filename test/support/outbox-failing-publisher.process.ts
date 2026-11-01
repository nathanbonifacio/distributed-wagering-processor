import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { PublishOutboxBatch } from '../../src/app/messaging/application/publish-outbox-batch.use-case';
import type { WageringPersistence } from '../../src/app/wagering/application/ports/wagering-persistence.port';
import { MikroOrmUnitOfWork } from '../../src/database/mikro-orm-unit-of-work';
import { createPersistenceContext, PERSISTENCE_SCHEMAS } from '../../src/persistence.module';

/**
 * Independent OS process that keeps failing to publish, with a lease so short that publishers overlap on the same
 * rows. The clock runs ahead so backoff never holds a row back. Prints how many failures it reported.
 */
const [url, rounds] = [process.argv[2]!, Number(process.argv[3])];
const orm = new MikroORM({ clientUrl: url, entities: PERSISTENCE_SCHEMAS, allowGlobalContext: false });
let ticks = 0;
const batch = new PublishOutboxBatch(
  new MikroOrmUnitOfWork<WageringPersistence>(orm, createPersistenceContext, 20_000),
  { publish: async () => { await Bun.sleep(5); throw new Error('injected'); } },
  { now: () => new Date(Date.now() + 600_000 * ++ticks) },
  { batchSize: 20, leaseMs: 1 },
);

let failed = 0;
for (let round = 0; round < rounds; round++) failed += (await batch.execute()).failed;
await orm.close(true);
console.log(JSON.stringify({ failed }));
