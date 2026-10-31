import { type EventContext, IntegrationEvent } from '../../../messaging/domain/integration-event';
import type { MoneyProps } from '../../../../shared/domain/money';
import type { LedgerDirection, WalletLedgerEntry } from '../ledger-entry.entity';

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Somente quando o saldo muda; por isso nasce do lançamento, que só existe nesse caso. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(entry: WalletLedgerEntry, context: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...context,
      aggregateId: entry.walletId,
      data: {
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }
}
