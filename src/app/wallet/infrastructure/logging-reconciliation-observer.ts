import { Logger } from '@nestjs/common';
import type { AppMetrics } from '../../../shared/observability/app-metrics';
import type { ReconciliationDivergence, ReconciliationObserver } from '../application/ports/reconciliation-observer.port';

/** Registra e conta a divergência. Só a diferença sai no log, nunca os saldos nem os lançamentos. */
export class LoggingReconciliationObserver implements ReconciliationObserver {
  private readonly logger = new Logger('Reconciliation');

  constructor(private readonly metrics?: AppMetrics) {}

  divergenceDetected({ walletId, difference, checkedEntries, foreignCurrencyEntries }: ReconciliationDivergence): void {
    this.metrics?.reconciliationDivergences.inc();
    this.logger.error({
      msg: 'reconciliation divergence detected',
      walletId,
      difference: difference.toString(),
      checkedEntries,
      foreignCurrencyEntries,
    });
  }
}
