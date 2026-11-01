import type { Money } from '../../../../shared/domain/money';

export interface ReconciliationDivergence {
  walletId: string;
  /** Saldo guardado menos saldo reconstruído pelo ledger. */
  difference: Money;
  checkedEntries: number;
  foreignCurrencyEntries: number;
}

/** Quem é avisado de uma divergência: log e métrica. A reconciliação nunca corrige nada por conta própria. */
export interface ReconciliationObserver {
  divergenceDetected(divergence: ReconciliationDivergence): void;
}
