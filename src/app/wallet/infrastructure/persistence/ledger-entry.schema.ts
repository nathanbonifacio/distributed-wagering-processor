import { EntitySchema } from '@mikro-orm/postgresql';

export interface LedgerEntryRow {
  id: string;
  /** Gerado pelo banco. O driver devolve bigint nativo; o repositório expõe como string. */
  seq?: bigint;
  walletId: string;
  transactionId: string;
  walletVersion: number;
  direction: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  currency: string;
  createdAt: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRow>({
  name: 'LedgerEntryRow',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    seq: { type: 'bigint', nullable: true },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    transactionId: { type: 'uuid', fieldName: 'transaction_id' },
    walletVersion: { type: 'integer', fieldName: 'wallet_version' },
    direction: { type: 'string', columnType: 'text' },
    amount: { type: 'string', columnType: 'numeric(20,2)' },
    balanceBefore: { type: 'string', fieldName: 'balance_before', columnType: 'numeric(20,2)' },
    balanceAfter: { type: 'string', fieldName: 'balance_after', columnType: 'numeric(20,2)' },
    currency: { type: 'string', columnType: 'char(3)' },
    createdAt: { type: 'datetime', fieldName: 'created_at', columnType: 'timestamptz' },
  },
});
