import { expect } from 'bun:test';
import { Money } from '../../src/shared/domain/money';
import { moneyFromColumn } from '../../src/shared/infrastructure/persistence/money-column';
import type { TestDatabase } from './test-database';

interface WalletRow { balance: string; currency: string; version: number }
interface EntryRow {
  id: string;
  transaction_id: string;
  wallet_version: number;
  direction: string;
  amount: string;
  balance_before: string;
  balance_after: string;
  currency: string;
}
interface TransactionRow {
  id: string;
  kind: string;
  status: string;
  amount: string;
  currency: string;
  observed_balance: string | null;
}

/**
 * README, seção 13: `wallet.balance == saldo reconstruído pelo ledger`. Lê só o banco, sem passar pelo
 * código de produção, e soma com Money. Valores saem como texto, para nunca passarem por `number`.
 * Considera o OPENING, que é um lançamento como os outros.
 */
export async function assertFinancialInvariants(db: TestDatabase, walletId: string): Promise<void> {
  const [wallet] = await db.sql<WalletRow>('SELECT balance::text AS balance, currency, version FROM wallets WHERE id = ?', [walletId]);
  if (!wallet) throw new Error(`wallet ${walletId} não existe`);

  const entries = await db.sql<EntryRow>(
    `SELECT id, transaction_id, wallet_version, direction, amount::text AS amount, balance_before::text AS balance_before,
            balance_after::text AS balance_after, currency
     FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY seq`,
    [walletId],
  );
  const transactions = await db.sql<TransactionRow>(
    `SELECT id, kind, status, amount::text AS amount, currency, observed_balance::text AS observed_balance
     FROM wager_transactions WHERE wallet_id = ?`,
    [walletId],
  );

  // Saldo reconstruído pelo ledger, com aritmética exata e encadeada.
  const stored = moneyFromColumn(wallet.balance, wallet.currency);
  let rebuilt = Money.zero(wallet.currency);
  for (const entry of entries) {
    expect(entry.currency).toBe(wallet.currency);
    const amount = moneyFromColumn(entry.amount, entry.currency);
    expect(moneyFromColumn(entry.balance_before, entry.currency).equals(rebuilt)).toBe(true);
    rebuilt = entry.direction === 'CREDIT' ? rebuilt.add(amount) : rebuilt.subtract(amount);
    expect(rebuilt.isNegative()).toBe(false);
    expect(moneyFromColumn(entry.balance_after, entry.currency).equals(rebuilt)).toBe(true);
  }
  expect(rebuilt.toJSON()).toEqual(stored.toJSON());
  expect(stored.isNegative()).toBe(false);

  // Versão: começa em 1, o OPENING ocupa a 1, e cada movimento seguinte ocupa exatamente uma.
  const versions = entries.map((entry) => entry.wallet_version);
  expect(wallet.version).toBe(Math.max(1, ...versions));
  const firstVersion = entries.length > 0 && transactions.some((t) => t.kind === 'OPENING') ? 1 : 2;
  expect(versions).toEqual(versions.map((_, index) => firstVersion + index));

  // Todo movimento tem lançamento, e vice-versa: nenhum duplicado, nenhum órfão.
  const statusOf = new Map(transactions.map((t) => [t.id, t]));
  expect(new Set(entries.map((entry) => entry.transaction_id)).size).toBe(entries.length);
  for (const entry of entries) {
    const owner = statusOf.get(entry.transaction_id);
    expect(owner?.status).toBe('PROCESSED');
    expect(owner?.kind).not.toBe('LOSS');
    expect(owner?.amount).toBe(entry.amount);
    expect(owner?.observed_balance).toBe(entry.balance_after);
  }
  const withEntry = new Set(entries.map((entry) => entry.transaction_id));
  for (const transaction of transactions) {
    if (transaction.status === 'PROCESSED' && transaction.kind !== 'LOSS') expect(withEntry.has(transaction.id)).toBe(true);
    if (transaction.status !== 'PROCESSED' || transaction.kind === 'LOSS') expect(withEntry.has(transaction.id)).toBe(false);
  }
}

/** Lançamentos de movimento, sem o OPENING. */
export async function movementsOf(db: TestDatabase, walletId: string): Promise<Array<{ direction: string; kind: string; transaction_id: string }>> {
  return db.sql(
    `SELECT l.direction, t.kind, l.transaction_id FROM wallet_ledger_entries l
     JOIN wager_transactions t ON t.id = l.transaction_id
     WHERE l.wallet_id = ? AND t.kind <> 'OPENING' ORDER BY l.seq`,
    [walletId],
  );
}
