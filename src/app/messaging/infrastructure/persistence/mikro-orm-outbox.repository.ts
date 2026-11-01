import { type EntityManager, LockMode } from '@mikro-orm/postgresql';
import type { OutboxRecord, OutboxRepository } from '../../application/ports/outbox.repository.port';
import { OutboxMessage } from '../../domain/outbox-message';
import { type OutboxMessageRow, OutboxMessageSchema } from './outbox-message.schema';

function toDomain(row: OutboxMessageRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregateId,
    eventType: row.eventType,
    payload: row.payload,
    occurredAt: row.occurredAt,
    attempts: row.attempts ?? 0,
    nextAttemptAt: row.nextAttemptAt,
    publishedAt: row.publishedAt ?? undefined,
    lastError: row.lastError ?? undefined,
  });
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(record: OutboxRecord): Promise<void> {
    await this.em.insert(OutboxMessageSchema, { ...record, payload: { ...record.payload } });
  }

  async claimDue(now: Date, limit: number, leaseUntil: Date): Promise<OutboxMessage[]> {
    const rows = await this.em.find(
      OutboxMessageSchema,
      { publishedAt: null, nextAttemptAt: { $lte: now } },
      {
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        orderBy: { nextAttemptAt: 'asc' },
        limit,
        disableIdentityMap: true,
      },
    );
    if (rows.length === 0) return [];
    await this.em.nativeUpdate(OutboxMessageSchema, { id: { $in: rows.map((row) => row.id) } }, { nextAttemptAt: leaseUntil });
    return rows.map((row) => toDomain({ ...row, nextAttemptAt: leaseUntil }));
  }

  async lockByIds(ids: string[]): Promise<OutboxMessage[]> {
    const rows = await this.em.find(
      OutboxMessageSchema,
      { id: { $in: ids } },
      { lockMode: LockMode.PESSIMISTIC_WRITE, orderBy: { id: 'asc' }, disableIdentityMap: true },
    );
    return rows.map(toDomain);
  }

  /** O filtro é a garantia: sem `publishedAt`, `attempts` e `nextAttemptAt` iguais ao que foi lido, nada é gravado. */
  async save(message: OutboxMessage): Promise<boolean> {
    const loaded = message.persistedState;
    if (!loaded) throw new Error(`outbox message ${message.id} was never loaded from the table`);
    const updated = await this.em.nativeUpdate(
      OutboxMessageSchema,
      { id: message.id, publishedAt: null, attempts: loaded.attempts, nextAttemptAt: loaded.nextAttemptAt },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt,
        publishedAt: message.publishedAt ?? null,
        lastError: message.lastError ?? null,
      },
    );
    return updated === 1;
  }
}
