import type { UnitOfWork } from '../../../shared/application/unit-of-work.port';
import type { Wallet } from '../domain/wallet.entity';
import type { LedgerPage } from './ports/ledger.repository.port';
import type { WalletPersistence } from './ports/wallet-persistence.port';

/** Consultas de wallet e ledger. Só leem; ausente é `undefined`, e cabe ao adaptador dizer o que isso significa. */
export class WalletQueries {
  constructor(private readonly unitOfWork: UnitOfWork<WalletPersistence>) {}

  getWallet(walletId: string): Promise<Wallet | undefined> {
    return this.unitOfWork.run((persistence) => persistence.wallets.findById(walletId));
  }

  listLedger(walletId: string, options: { afterSeq?: string; limit: number }): Promise<LedgerPage | undefined> {
    return this.unitOfWork.run(async (persistence) => {
      if (!(await persistence.wallets.findById(walletId))) return undefined;
      return persistence.ledger.listByWallet(walletId, options);
    });
  }
}
