import { z } from 'zod';
import { identifierSchema, moneySchema, uuidSchema } from '../../../shared/application/contract-schemas';
import { INTERNAL_PROVIDER_ID, WagerTransactionKind as Kind } from '../domain/wager-transaction.entity';

/**
 * Campos de negócio de uma submissão, compartilhados entre os adaptadores de entrada. Campos
 * desconhecidos são recusados: o hash os ignoraria, e dois payloads diferentes pareceriam idênticos.
 * OPENING e o provider reservado não passam. As regras por kind continuam em WagerTransaction.create.
 */
export const wagerPayloadSchema = z.strictObject({
  providerId: identifierSchema.refine((id) => id !== INTERNAL_PROVIDER_ID, `the provider "${INTERNAL_PROVIDER_ID}" is reserved`),
  externalTransactionId: identifierSchema,
  playerId: uuidSchema,
  walletId: uuidSchema,
  roundId: identifierSchema,
  gameId: identifierSchema,
  kind: z.enum([Kind.Bet, Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback]),
  money: moneySchema,
  referenceExternalTransactionId: identifierSchema.optional(),
});
