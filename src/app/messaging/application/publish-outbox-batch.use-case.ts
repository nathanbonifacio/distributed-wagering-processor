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

type PublishOutcome = { at: Date; published: true } | { at: Date; published: false; error: string };

/**
 * Publica um lote em três passos, sem transação distribuída:
 *
 * 1. transação curta: reserva os eventos, com SKIP LOCKED, e adia a próxima tentativa pelo prazo da reserva;
 * 2. fora de transação: publica, sem lock nem conexão presos durante a rede;
 * 3. transação curta: trava as linhas e grava o resultado sobre o estado atual, não sobre a cópia reservada. Uma
 *    reserva vencida, que outro publisher já assumiu, só conta a falha e nunca altera o agendamento do novo dono.
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
  ) {
    // O token da reserva é o instante em que ela vence. Com lease nulo, duas reservas poderiam coincidir nele.
    if (!Number.isInteger(options.leaseMs) || options.leaseMs <= 0) throw new RangeError('leaseMs must be a positive integer');
  }

  async execute(): Promise<PublishOutboxResult> {
    const now = this.clock.now();
    const leaseUntil = new Date(now.getTime() + this.options.leaseMs);
    const messages = await this.unitOfWork.run(({ outbox }) => outbox.claimDue(now, this.options.batchSize, leaseUntil));
    if (messages.length === 0) return { claimed: 0, published: 0, failed: 0 };

    const outcomes = new Map<string, PublishOutcome>();
    await Promise.all(
      messages.map(async (message) => {
        try {
          await this.publisher.publish(message);
          outcomes.set(message.id, { at: this.clock.now(), published: true });
        } catch (error) {
          // Só o nome do erro: a mensagem pode trazer endereços internos.
          outcomes.set(message.id, { at: this.clock.now(), published: false, error: error instanceof Error ? error.name : 'UnknownError' });
        }
      }),
    );

    // Decide sobre a linha travada, não sobre a cópia da reserva: outro publisher pode tê-la assumido.
    await this.unitOfWork.run(async ({ outbox }) => {
      for (const current of await outbox.lockByIds([...outcomes.keys()])) {
        const outcome = outcomes.get(current.id)!;
        if (outcome.published) current.confirmPublished(outcome.at);
        else current.registerFailure(leaseUntil, outcome.at, outcome.error);
        await outbox.save(current);
      }
    });
    const published = [...outcomes.values()].filter((outcome) => outcome.published).length;
    return { claimed: messages.length, published, failed: messages.length - published };
  }
}
