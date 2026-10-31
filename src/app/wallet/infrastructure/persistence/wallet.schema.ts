import { EntitySchema } from '@mikro-orm/postgresql';

/** Linha plana de `wallets`. O domínio não é mapeado diretamente: `Wallet` tem construtor privado. */
export interface WalletRow {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const WalletSchema = new EntitySchema<WalletRow>({
  name: 'WalletRow',
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    currency: { type: 'string', columnType: 'char(3)' },
    balance: { type: 'string', columnType: 'numeric(20,2)' },
    version: { type: 'integer' },
    createdAt: { type: 'datetime', fieldName: 'created_at', columnType: 'timestamptz' },
    updatedAt: { type: 'datetime', fieldName: 'updated_at', columnType: 'timestamptz' },
  },
});
