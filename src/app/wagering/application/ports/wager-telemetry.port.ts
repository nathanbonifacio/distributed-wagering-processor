import type { FailureCode } from '../../domain/failure-code';
import type { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction.entity';

export type WagerSource = 'http' | 'sqs' | 'retry';

export interface WagerHandled {
  source: WagerSource;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  /** Resposta repetida de uma operação já decidida. */
  replay: boolean;
  durationMs: number;
  transactionId: string;
  walletId: string;
  providerId: string;
}

/**
 * O que o processamento financeiro conta e registra. Só identificadores e códigos: nunca valores, saldos
 * ou o payload. As implementações decidem o que vira log e o que vira métrica.
 */
export interface WagerTelemetry {
  /** Uma chamada por operação decidida (ou repetida), HTTP, SQS ou retomada de pendente. */
  handled(event: WagerHandled): void;
  /** O messageId já estava no inbox: a entrega repetida não gerou efeito. */
  duplicateMessage(event: { consumerName: string; messageId: string; walletId: string; providerId: string }): void;
  /** Mesma chave de idempotência (ou id externo) com outro payload. */
  idempotencyConflict(event: { walletId: string; providerId: string }): void;
  /** Tempo esperando o lock da wallet. */
  walletLockAcquired(event: { walletId: string; waitedMs: number }): void;
  /** Duas operações com a mesma chave em wallets diferentes: a unique decidiu. */
  uniqueCollision(event: { walletId: string; providerId: string }): void;
  /** Uma referência ainda ausente reagendou a tentativa. */
  referenceRescheduled(event: { transactionId: string; walletId: string; providerId: string; attempts: number }): void;
}

export const NO_WAGER_TELEMETRY: WagerTelemetry = {
  handled: () => undefined,
  duplicateMessage: () => undefined,
  idempotencyConflict: () => undefined,
  walletLockAcquired: () => undefined,
  uniqueCollision: () => undefined,
  referenceRescheduled: () => undefined,
};
