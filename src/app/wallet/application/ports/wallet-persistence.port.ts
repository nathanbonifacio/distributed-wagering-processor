import type { LedgerRepository } from './ledger.repository.port';
import type { WalletRepository } from './wallet.repository.port';

/** Repositórios de wallet ligados à transação corrente. */
export interface WalletPersistence {
  wallets: WalletRepository;
  ledger: LedgerRepository;
}
