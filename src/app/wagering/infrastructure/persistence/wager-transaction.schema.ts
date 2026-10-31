import { EntitySchema } from '@mikro-orm/postgresql';

export interface WagerTransactionRow {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  observedBalance: string | null;
  observedBalanceCurrency: string | null;
  attempts: number;
  nextAttemptAt: Date | null;
  createdAt: Date;
  processedAt: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRow>({
  name: 'WagerTransactionRow',
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', fieldName: 'provider_id', columnType: 'text' },
    externalTransactionId: { type: 'string', fieldName: 'external_transaction_id', columnType: 'text' },
    idempotencyKey: { type: 'string', fieldName: 'idempotency_key', columnType: 'text' },
    payloadHash: { type: 'string', fieldName: 'payload_hash', columnType: 'char(64)' },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    roundId: { type: 'string', fieldName: 'round_id', columnType: 'text' },
    gameId: { type: 'string', fieldName: 'game_id', columnType: 'text' },
    kind: { type: 'string', columnType: 'text' },
    amount: { type: 'string', columnType: 'numeric(20,2)' },
    currency: { type: 'string', columnType: 'char(3)' },
    referenceExternalTransactionId: { type: 'string', fieldName: 'reference_external_transaction_id', columnType: 'text', nullable: true },
    referenceTransactionId: { type: 'uuid', fieldName: 'reference_transaction_id', nullable: true },
    status: { type: 'string', columnType: 'text' },
    failureCode: { type: 'string', fieldName: 'failure_code', columnType: 'text', nullable: true },
    observedBalance: { type: 'string', fieldName: 'observed_balance', columnType: 'numeric(20,2)', nullable: true },
    observedBalanceCurrency: { type: 'string', fieldName: 'observed_balance_currency', columnType: 'char(3)', nullable: true },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'datetime', fieldName: 'next_attempt_at', columnType: 'timestamptz', nullable: true },
    createdAt: { type: 'datetime', fieldName: 'created_at', columnType: 'timestamptz' },
    processedAt: { type: 'datetime', fieldName: 'processed_at', columnType: 'timestamptz', nullable: true },
  },
});
