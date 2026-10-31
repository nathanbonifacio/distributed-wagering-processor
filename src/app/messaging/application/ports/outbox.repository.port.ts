/** Registro plano: OutboxMessage, IntegrationEvent e o publisher entram na Etapa 8. */
export interface OutboxRecord {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  nextAttemptAt: Date;
}

export interface OutboxRepository {
  enqueue(record: OutboxRecord): Promise<void>;
}
