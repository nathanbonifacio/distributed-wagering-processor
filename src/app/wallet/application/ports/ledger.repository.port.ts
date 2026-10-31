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

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  listByWallet(walletId: string, options: { afterSeq?: string; limit: number }): Promise<LedgerPage>;
  totals(walletId: string, currency: string): Promise<LedgerTotals>;
}
