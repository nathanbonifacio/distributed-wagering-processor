import { type EventContext, IntegrationEvent } from '../../../messaging/domain/integration-event';
import type { MoneyProps } from '../../../../shared/domain/money';
import type { FailureCode } from '../failure-code';
import type { WagerTransaction, WagerTransactionKind } from '../wager-transaction.entity';

interface WagerTransactionData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface WagerTransactionProcessedData extends WagerTransactionData {
  balance: MoneyProps;
  referenceTransactionId?: string;
}

export interface WagerTransactionRejectedData extends WagerTransactionData {
  failureCode: FailureCode;
  balance: MoneyProps;
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionData {
  nextAttemptAt: string;
}

function baseData(transaction: WagerTransaction): WagerTransactionData {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    ...(transaction.referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId: transaction.referenceExternalTransactionId }),
  };
}

/** Qualquer transação aplicada, inclusive LOSS e OPENING. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      ...context,
      aggregateId: transaction.id,
      data: {
        ...baseData(transaction),
        balance: transaction.observedBalance!.toJSON(),
        ...(transaction.referenceTransactionId === undefined
          ? {}
          : { referenceTransactionId: transaction.referenceTransactionId }),
      },
    });
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
      ...context,
      aggregateId: transaction.id,
      data: {
        ...baseData(transaction),
        failureCode: transaction.failureCode!,
        balance: transaction.observedBalance!.toJSON(),
      },
    });
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      ...context,
      aggregateId: transaction.id,
      data: { ...baseData(transaction), nextAttemptAt: transaction.nextAttemptAt!.toISOString() },
    });
  }
}
