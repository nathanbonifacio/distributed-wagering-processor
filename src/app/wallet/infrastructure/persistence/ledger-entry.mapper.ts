import { moneyFromColumn, moneyToColumn } from '../../../../shared/infrastructure/persistence/money-column';
import { type LedgerDirection, WalletLedgerEntry } from '../../domain/ledger-entry.entity';
import type { LedgerEntryRow } from './ledger-entry.schema';

export function ledgerEntryToDomain(row: LedgerEntryRow): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.walletId,
    transactionId: row.transactionId,
    walletVersion: row.walletVersion,
    direction: row.direction as LedgerDirection,
    money: moneyFromColumn(row.amount, row.currency),
    balanceBefore: moneyFromColumn(row.balanceBefore, row.currency),
    balanceAfter: moneyFromColumn(row.balanceAfter, row.currency),
    createdAt: row.createdAt,
  });
}

export function ledgerEntryToRow(entry: WalletLedgerEntry): LedgerEntryRow {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    walletVersion: entry.walletVersion,
    direction: entry.direction,
    amount: moneyToColumn(entry.money),
    balanceBefore: moneyToColumn(entry.balanceBefore),
    balanceAfter: moneyToColumn(entry.balanceAfter),
    currency: entry.money.currency,
    createdAt: entry.createdAt,
  };
}
