import type { Clock } from '../../../shared/application/clock.port';
import type { UnitOfWork } from '../../../shared/application/unit-of-work.port';
import type { MessagePublisher } from './ports/message-publisher.port';
import type { OutboxRepository } from './ports/outbox.repository.port';

export interface PublishOutboxOptions {
  batchSize: number;
  /** Tempo reservado a este publisher. Precisa superar o prazo de publicação. */
  leaseMs: number;
}

export interface PublishOutboxResult {
  claimed: number;
  published: number;
  failed: number;
}

/**
 * Publica um lote em três passos, sem transação distribuída:
 *
 * 1. transação curta: reserva os eventos, com SKIP LOCKED, e adia a próxima tentativa pelo prazo da reserva;
 * 2. fora de transação: publica, sem lock nem conexão presos durante a rede;
 * 3. transação curta: grava o resultado.
 *
 * Se o processo morrer entre os passos, a reserva vence e outra instância publica. Morrer depois do
 * passo 2 gera publicação duplicada, com o mesmo eventId: a entrega é at-least-once por definição.
 */
export class PublishOutboxBatch {
  constructor(
    private readonly unitOfWork: UnitOfWork<{ outbox: OutboxRepository }>,
    private readonly publisher: MessagePublisher,
    private readonly clock: Clock,
    private readonly options: PublishOutboxOptions,
  ) {}

  async execute(): Promise<PublishOutboxResult> {
    const now = this.clock.now();
    const leaseUntil = new Date(now.getTime() + this.options.leaseMs);
    const messages = await this.unitOfWork.run(({ outbox }) => outbox.claimDue(now, this.options.batchSize, leaseUntil));
    if (messages.length === 0) return { claimed: 0, published: 0, failed: 0 };

    let published = 0;
    await Promise.all(
      messages.map(async (message) => {
        try {
          await this.publisher.publish(message);
          message.markPublished(this.clock.now());
          published += 1;
        } catch (error) {
          // Só o nome do erro: a mensagem pode trazer endereços internos.
          message.scheduleRetry(this.clock.now(), error instanceof Error ? error.name : 'UnknownError');
        }
      }),
    );

    await this.unitOfWork.run(async ({ outbox }) => {
      for (const message of messages) await outbox.save(message);
    });
    return { claimed: messages.length, published, failed: messages.length - published };
  }
}
