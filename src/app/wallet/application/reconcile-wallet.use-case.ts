import type { UnitOfWork } from '../../../shared/application/unit-of-work.port';
import type { Money } from '../../../shared/domain/money';
import type { ReconciliationObserver } from './ports/reconciliation-observer.port';
import type { WalletPersistence } from './ports/wallet-persistence.port';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  /** Guardado menos calculado: zero quando consistente. */
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Confere o saldo guardado contra o ledger. Só lê: uma divergência é avisada ao observador e devolvida na
 * resposta, nunca corrigida. Lançamento em outra moeda também é divergência, mesmo com diferença zero.
 */
export class ReconcileWallet {
  constructor(
    private readonly unitOfWork: UnitOfWork<WalletPersistence>,
    private readonly observer: ReconciliationObserver,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport | undefined> {
    const snapshot = await this.unitOfWork.run((persistence) => persistence.ledger.reconciliationSnapshot(walletId));
    if (!snapshot) return undefined;

    const difference = snapshot.storedBalance.subtract(snapshot.calculatedBalance);
    const consistent = difference.isZero() && snapshot.foreignCurrencyEntries === 0;
    if (!consistent) {
      this.observer.divergenceDetected({
        walletId,
        difference,
        checkedEntries: snapshot.entryCount,
        foreignCurrencyEntries: snapshot.foreignCurrencyEntries,
      });
    }
    return {
      walletId,
      storedBalance: snapshot.storedBalance,
      calculatedBalance: snapshot.calculatedBalance,
      difference,
      consistent,
      checkedEntries: snapshot.entryCount,
    };
  }
}
