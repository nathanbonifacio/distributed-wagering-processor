import { EntitySchema } from '@mikro-orm/postgresql';

export interface OutboxMessageRow {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts?: number;
  nextAttemptAt: Date;
  publishedAt?: Date | null;
  lastError?: string | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRow>({
  name: 'OutboxMessageRow',
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid', fieldName: 'aggregate_id' },
    eventType: { type: 'string', fieldName: 'event_type', columnType: 'text' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: { type: 'datetime', fieldName: 'occurred_at', columnType: 'timestamptz' },
    attempts: { type: 'integer', nullable: true },
    nextAttemptAt: { type: 'datetime', fieldName: 'next_attempt_at', columnType: 'timestamptz' },
    publishedAt: { type: 'datetime', fieldName: 'published_at', columnType: 'timestamptz', nullable: true },
    lastError: { type: 'string', fieldName: 'last_error', columnType: 'text', nullable: true },
  },
});
