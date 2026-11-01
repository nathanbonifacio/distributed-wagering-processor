import { type BeforeApplicationShutdown, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { RetryPendingReferences } from '../application/retry-pending-references.use-case';

/**
 * Lote cheio e sem falhas: pode haver mais, e segue sem esperar. Com falha, espera o intervalo mesmo
 * com o lote cheio: durante uma indisponibilidade, as mesmas linhas continuam vencidas.
 */
export class PendingReferenceRetrierLoop implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(PendingReferenceRetrierLoop.name);
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;

  constructor(
    private readonly retryPending: RetryPendingReferences,
    private readonly batchSize: number,
    private readonly pollIntervalMs: number,
  ) {}

  onApplicationBootstrap(): void {
    this.running = this.tick();
  }

  /** Conclui a operação em andamento e não começa outra. O resto continua no banco, para qualquer instância. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  private async tick(): Promise<void> {
    let delay = this.pollIntervalMs;
    try {
      const { claimed, failed, failures } = await this.retryPending.execute(() => this.stopped);
      if (failed > 0) this.logger.warn(`failed to retry ${failed} pending transactions: ${[...new Set(failures)].join(', ')}`);
      else if (claimed === this.batchSize) delay = 0;
    } catch (error) {
      this.logger.warn(`failed to load pending transactions: ${error instanceof Error ? error.name : typeof error}`);
    }
    if (!this.stopped) {
      this.timer = setTimeout(() => {
        this.running = this.tick();
      }, delay);
    }
  }
}
