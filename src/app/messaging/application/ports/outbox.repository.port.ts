import type { OutboxMessage } from '../../domain/outbox-message';

/** Registro plano gravado na mesma transação da alteração financeira. */
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
  /**
   * Reserva até `limit` eventos vencidos, com FOR UPDATE SKIP LOCKED, adiando a próxima tentativa para
   * `leaseUntil`. Publishers concorrentes recebem lotes disjuntos, sem esperar um pelo outro.
   */
  claimDue(now: Date, limit: number, leaseUntil: Date): Promise<OutboxMessage[]>;
  /** Grava o resultado da publicação. Nunca desfaz um evento já marcado como publicado. */
  save(message: OutboxMessage): Promise<void>;
}
