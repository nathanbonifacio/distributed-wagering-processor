import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../shared/application/canonical-json';
import type { Money } from '../../../shared/domain/money';
import type { WagerTransactionKind } from '../domain/wager-transaction.entity';

export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

/**
 * SHA-256 do JSON canônico dos campos de negócio, listados um a um: o header Idempotency-Key, o
 * messageId e demais metadados de transporte nunca entram, mesmo que venham no objeto recebido.
 */
export function wagerPayloadHash(payload: WagerPayload): string {
  const canonical = canonicalJson({
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: payload.money.toJSON(),
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
