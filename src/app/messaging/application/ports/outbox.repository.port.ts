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
  /** Trava as linhas com FOR UPDATE e devolve o estado atual, sempre em ordem de id: lotes sobrepostos não entram em deadlock. */
  lockByIds(ids: string[]): Promise<OutboxMessage[]>;
  /**
   * Grava o resultado como compare-and-set: só se a linha ainda estiver como a mensagem foi lida (`persistedState`: tentativas e
   * `nextAttemptAt`) e não publicada. Devolve `false` quando outra reserva ou publicação já a alterou, e então nada muda.
   * Recusa mensagens que nunca foram lidas da tabela.
   */
  save(message: OutboxMessage): Promise<boolean>;
}
