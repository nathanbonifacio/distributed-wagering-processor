import type { Money } from '../../../../shared/domain/money';
import type { WalletLedgerEntry } from '../../domain/ledger-entry.entity';

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  /** Posição do último item, para pedir a página seguinte. */
  lastSeq?: string;
}

export interface LedgerTotals {
  /** Créditos menos débitos: o saldo reconstruído pelo ledger. */
  signedTotal: Money;
  entryCount: number;
}

/** Saldo guardado e saldo reconstruído pelo ledger, lidos juntos: um único instantâneo do banco. */
export interface ReconciliationSnapshot {
  storedBalance: Money;
  /** Créditos menos débitos dos lançamentos na moeda da wallet. */
  calculatedBalance: Money;
  entryCount: number;
  /** Lançamentos em outra moeda: nunca somados ao saldo, e sempre uma anomalia. */
  foreignCurrencyEntries: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  listByWallet(walletId: string, options: { afterSeq?: string; limit: number }): Promise<LedgerPage>;
  totals(walletId: string, currency: string): Promise<LedgerTotals>;
  /** Uma única instrução SQL, sem lock: não bloqueia escritas e nunca vê um saldo sem o lançamento dele. */
  reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | undefined>;
}
