import type { IntegrationEvent } from '../domain/integration-event';
import { OutboxMessage } from '../domain/outbox-message';
import type { OutboxRecord } from './ports/outbox.repository.port';

/** O id da linha é o eventId, estável entre publicações. A linha já nasce pronta para o publisher. */
export function outboxRecordOf(event: IntegrationEvent<unknown>): OutboxRecord {
  const message = OutboxMessage.enqueue(event);
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    payload: message.payload,
    occurredAt: message.occurredAt,
    nextAttemptAt: message.nextAttemptAt,
  };
}
