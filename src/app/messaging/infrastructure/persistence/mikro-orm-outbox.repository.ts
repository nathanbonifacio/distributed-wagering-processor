import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxRecord, OutboxRepository } from '../../application/ports/outbox.repository.port';
import { OutboxMessageSchema } from './outbox-message.schema';

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(record: OutboxRecord): Promise<void> {
    await this.em.insert(OutboxMessageSchema, { ...record, payload: { ...record.payload } });
  }
}
