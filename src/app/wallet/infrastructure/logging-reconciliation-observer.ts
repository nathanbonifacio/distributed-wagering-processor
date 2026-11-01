import { Logger } from '@nestjs/common';
import type { ReconciliationDivergence, ReconciliationObserver } from '../application/ports/reconciliation-observer.port';

/** Registra só o necessário para diagnosticar: a diferença, e nunca os saldos nem os lançamentos. */
export class LoggingReconciliationObserver implements ReconciliationObserver {
  private readonly logger = new Logger('Reconciliation');

  divergenceDetected({ walletId, difference, checkedEntries, foreignCurrencyEntries }: ReconciliationDivergence): void {
    this.logger.error(
      `reconciliation divergence detected: walletId=${walletId} difference=${difference.toString()} checkedEntries=${checkedEntries} foreignCurrencyEntries=${foreignCurrencyEntries}`,
    );
  }
}
