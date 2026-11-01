import { Logger } from '@nestjs/common';
import type { AppMetrics } from '../../../shared/observability/app-metrics';
import type { WagerHandled, WagerTelemetry } from '../application/ports/wager-telemetry.port';
import { WagerTransactionStatus } from '../domain/wager-transaction.entity';

/** Esperar mais que isto pelo lock da wallet já merece uma linha de log: abaixo disso é o custo normal. */
const NOTABLE_LOCK_WAIT_MS = 100;

/**
 * Traduz o que o processamento financeiro conta em log e métrica. Só identificadores e códigos entram nos
 * logs: nunca valores, saldos ou o payload.
 */
export class ObservedWagerTelemetry implements WagerTelemetry {
  private readonly logger = new Logger('Wagering');

  constructor(private readonly metrics: AppMetrics) {}

  handled(event: WagerHandled): void {
    this.metrics.transactions.inc({ source: event.source, kind: event.kind, status: event.status });
    this.metrics.processingDuration.observe({ source: event.source }, event.durationMs / 1000);
    if (event.replay) this.metrics.duplicates.inc({ type: 'idempotent_replay' });

    const { durationMs, ...fields } = event;
    const entry = { msg: 'transaction handled', ...fields, durationMs: Math.round(durationMs) };
    if (event.status === WagerTransactionStatus.Failed) this.logger.error(entry);
    else this.logger.log(entry);
  }

  duplicateMessage(event: { consumerName: string; messageId: string; walletId: string; providerId: string }): void {
    this.metrics.duplicates.inc({ type: 'inbox_message' });
    this.logger.log({ msg: 'duplicate message ignored', ...event });
  }

  idempotencyConflict(event: { walletId: string; providerId: string }): void {
    this.metrics.idempotencyConflicts.inc();
    this.logger.warn({ msg: 'idempotency conflict: key or external id reused with another payload', ...event });
  }

  walletLockAcquired(event: { walletId: string; waitedMs: number }): void {
    this.metrics.lockWait.observe(event.waitedMs / 1000);
    if (event.waitedMs >= NOTABLE_LOCK_WAIT_MS) {
      this.logger.log({ msg: 'waited for the wallet lock', walletId: event.walletId, waitedMs: Math.round(event.waitedMs) });
    }
  }

  uniqueCollision(event: { walletId: string; providerId: string }): void {
    this.metrics.lockConflicts.inc({ type: 'unique_collision' });
    this.logger.log({ msg: 'same key in another wallet: the unique constraint decided', ...event });
  }

  referenceRescheduled(event: { transactionId: string; walletId: string; providerId: string; attempts: number }): void {
    this.metrics.retries.inc({ kind: 'pending_reference' });
    this.logger.log({ msg: 'reference still missing: retry rescheduled', ...event });
  }
}
