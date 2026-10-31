import { moneyFromColumn, moneyToColumn } from '../../../../shared/infrastructure/persistence/money-column';
import { Wallet } from '../../domain/wallet.entity';
import type { WalletRow } from './wallet.schema';

export function walletToDomain(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    currency: row.currency,
    balance: moneyFromColumn(row.balance, row.currency),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export function walletToRow(wallet: Wallet): WalletRow {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: moneyToColumn(wallet.balance),
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}
