import type { OutboxMessage } from '../../domain/outbox-message';

export interface MessagePublisher {
  /** Só resolve depois de o transporte confirmar o recebimento. */
  publish(message: OutboxMessage): Promise<void>;
}
