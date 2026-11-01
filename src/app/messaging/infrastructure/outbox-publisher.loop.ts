import { type BeforeApplicationShutdown, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { PublishOutboxBatch } from '../application/publish-outbox-batch.use-case';

/** Lote cheio: pode haver mais, e segue sem esperar. Caso contrário, espera o intervalo. */
export class OutboxPublisherLoop implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(OutboxPublisherLoop.name);
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;

  constructor(
    private readonly publishBatch: PublishOutboxBatch,
    private readonly batchSize: number,
    private readonly pollIntervalMs: number,
  ) {}

  onApplicationBootstrap(): void {
    this.running = this.tick();
  }

  /** Antes de o banco fechar: conclui o lote em andamento. O que sobrar, outra instância publica. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  private async tick(): Promise<void> {
    let delay = this.pollIntervalMs;
    try {
      const { claimed } = await this.publishBatch.execute();
      if (claimed === this.batchSize) delay = 0;
    } catch (error) {
      // Banco fora do ar não derruba o worker. Só o nome do erro: a mensagem pode trazer SQL.
      this.logger.warn(`falha ao publicar a outbox: ${error instanceof Error ? error.name : typeof error}`);
    }
    if (!this.stopped) {
      this.timer = setTimeout(() => {
        this.running = this.tick();
      }, delay);
    }
  }
}
