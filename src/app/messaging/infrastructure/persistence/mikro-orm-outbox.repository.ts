import { type EntityManager, LockMode } from '@mikro-orm/postgresql';
import type { OutboxRecord, OutboxRepository } from '../../application/ports/outbox.repository.port';
import { OutboxMessage } from '../../domain/outbox-message';
import { OutboxMessageSchema } from './outbox-message.schema';

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
    return rows.map((row) =>
      OutboxMessage.rehydrate({
        id: row.id,
        aggregateId: row.aggregateId,
        eventType: row.eventType,
        payload: row.payload,
        occurredAt: row.occurredAt,
        attempts: row.attempts ?? 0,
        nextAttemptAt: leaseUntil,
        lastError: row.lastError ?? undefined,
      }),
    );
  }

  /** `publishedAt: null` no filtro: uma tentativa atrasada que falhou não reabre o que outra já publicou. */
  async save(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageSchema,
      { id: message.id, publishedAt: null },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt,
        publishedAt: message.publishedAt ?? null,
        lastError: message.lastError ?? null,
      },
    );
  }
}
