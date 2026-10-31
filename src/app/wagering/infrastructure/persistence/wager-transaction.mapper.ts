import { moneyFromColumn, moneyToColumn } from '../../../../shared/infrastructure/persistence/money-column';
import type { FailureCode } from '../../domain/failure-code';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../domain/wager-transaction.entity';
import type { WagerTransactionRow } from './wager-transaction.schema';

export function wagerTransactionToDomain(row: WagerTransactionRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind as WagerTransactionKind,
    money: moneyFromColumn(row.amount, row.currency),
    referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
    referenceTransactionId: row.referenceTransactionId ?? undefined,
    status: row.status as WagerTransactionStatus,
    failureCode: (row.failureCode ?? undefined) as FailureCode | undefined,
    observedBalance:
      row.observedBalance === null ? undefined : moneyFromColumn(row.observedBalance, row.observedBalanceCurrency!),
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt ?? undefined,
    createdAt: row.createdAt,
    processedAt: row.processedAt ?? undefined,
  });
}

export function wagerTransactionToRow(transaction: WagerTransaction): WagerTransactionRow {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    amount: moneyToColumn(transaction.money),
    currency: transaction.money.currency,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    observedBalance: transaction.observedBalance ? moneyToColumn(transaction.observedBalance) : null,
    observedBalanceCurrency: transaction.observedBalance?.currency ?? null,
    attempts: transaction.attempts,
    nextAttemptAt: transaction.nextAttemptAt ?? null,
    createdAt: transaction.createdAt,
    processedAt: transaction.processedAt ?? null,
  };
}
