import { Counter, Gauge, Histogram, Registry } from 'prom-client';

const SECONDS_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * Todas as métricas obrigatórias do README, em um registro próprio de cada processo (nunca o global, para
 * os testes não se contaminarem). Valores de dinheiro nunca viram rótulo ou valor de métrica.
 */
export class AppMetrics {
  readonly registry = new Registry();

  readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Transactions handled, by source, kind and resulting status.',
    labelNames: ['source', 'kind', 'status'] as const,
    registers: [this.registry],
  });
  readonly duplicates = new Counter({
    name: 'wager_duplicates_total',
    help: 'Duplicates detected: idempotent replays and redelivered inbox messages.',
    labelNames: ['type'] as const,
    registers: [this.registry],
  });
  readonly idempotencyConflicts = new Counter({
    name: 'wager_idempotency_conflicts_total',
    help: 'Requests rejected because the idempotency key or external id was reused with another payload.',
    registers: [this.registry],
  });
  readonly retries = new Counter({
    name: 'wager_retries_total',
    help: 'Retries scheduled: pending reference attempts, SQS redeliveries and outbox publications.',
    labelNames: ['kind'] as const,
    registers: [this.registry],
  });
  readonly dlqMessages = new Counter({
    name: 'wager_dlq_messages_total',
    help: 'Messages this process moved to the dead letter queue, by reason.',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });
  readonly lockConflicts = new Counter({
    name: 'wager_lock_conflicts_total',
    help: 'Concurrency conflicts: lock timeouts, deadlocks and unique collisions between wallets.',
    labelNames: ['type'] as const,
    registers: [this.registry],
  });
  readonly lockWait = new Histogram({
    name: 'wager_wallet_lock_wait_seconds',
    help: 'Time spent waiting for the wallet row lock.',
    buckets: SECONDS_BUCKETS,
    registers: [this.registry],
  });
  readonly processingDuration = new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'Time to process one transaction, by source.',
    labelNames: ['source'] as const,
    buckets: SECONDS_BUCKETS,
    registers: [this.registry],
  });
  readonly reconciliationDivergences = new Counter({
    name: 'wallet_reconciliation_divergences_total',
    help: 'Reconciliations that found a stored balance different from the ledger.',
    registers: [this.registry],
  });
  readonly outboxPublished = new Counter({
    name: 'wager_outbox_published_total',
    help: 'Outbox events published to the events queue.',
    registers: [this.registry],
  });

  /** Valor lido só no momento da coleta, por uma consulta barata. Falhar não derruba a coleta das outras métricas. */
  gauge(name: string, help: string, read: () => Promise<number>): void {
    new Gauge({
      name,
      help,
      registers: [this.registry],
      async collect() {
        try {
          this.set(await read());
        } catch {
          // Sem leitura nesta coleta: o valor anterior permanece, e as demais métricas seguem.
        }
      },
    });
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
