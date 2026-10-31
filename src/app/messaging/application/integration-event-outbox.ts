import type { IntegrationEvent } from '../domain/integration-event';
import type { OutboxRecord } from './ports/outbox.repository.port';

/** O id da linha é o eventId, estável entre publicações. A linha já nasce pronta para o publisher. */
export function outboxRecordOf(event: IntegrationEvent<unknown>): OutboxRecord {
  return {
    id: event.eventId,
    aggregateId: event.aggregateId,
    eventType: event.eventType,
    payload: { ...event.toJSON() },
    occurredAt: event.occurredAt,
    nextAttemptAt: event.occurredAt,
  };
}
