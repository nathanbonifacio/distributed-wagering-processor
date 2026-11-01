import { z } from 'zod';
import { identifierSchema } from '../../../shared/application/contract-schemas';
import { wagerPayloadSchema } from './wager-command.schema';

/** Envelope de entrada (README, seção 10). Os campos de negócio são os mesmos da API HTTP. */
export const wagerMessageSchema = z.strictObject({
  messageId: identifierSchema,
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.iso.datetime(),
  data: wagerPayloadSchema.extend({ idempotencyKey: identifierSchema }),
});
