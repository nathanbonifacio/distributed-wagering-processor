import type { EntityManager } from '@mikro-orm/postgresql';
import { moneyFromColumn } from '../../../../shared/infrastructure/persistence/money-column';
import type {
  LedgerPage,
  LedgerRepository,
  LedgerTotals,
  ReconciliationSnapshot,
} from '../../application/ports/ledger.repository.port';
import type { WalletLedgerEntry } from '../../domain/ledger-entry.entity';
import { ledgerEntryToDomain, ledgerEntryToRow } from './ledger-entry.mapper';
import { LedgerEntrySchema } from './ledger-entry.schema';

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntrySchema, ledgerEntryToRow(entry));
  }

  async listByWallet(walletId: string, options: { afterSeq?: string; limit: number }): Promise<LedgerPage> {
    const rows = await this.em.find(
      LedgerEntrySchema,
      options.afterSeq === undefined ? { walletId } : { walletId, seq: { $gt: BigInt(options.afterSeq) } },
      { orderBy: { seq: 'asc' }, limit: options.limit, disableIdentityMap: true },
    );
    return { entries: rows.map(ledgerEntryToDomain), lastSeq: rows.at(-1)?.seq?.toString() };
  }

  async totals(walletId: string, currency: string): Promise<LedgerTotals> {
    const [row] = await this.em.execute<Array<{ total: string; entries: string }>>(
      `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(20,2)::text AS total,
              COUNT(*)::text AS entries
       FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
    return { signedTotal: moneyFromColumn(row!.total, currency), entryCount: Number(row!.entries) };
  }

  async reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | undefined> {
    // Uma instrução só: saldo e ledger vêm do mesmo instante, mesmo com débitos e créditos confirmando em paralelo.
    const [row] = await this.em.execute<
      Array<{ stored: string; calculated: string; currency: string; entries: string; foreign_entries: string }>
    >(
      `SELECT w.balance::text AS stored, w.currency AS currency,
              COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END) FILTER (WHERE l.currency = w.currency), 0)::numeric(38,2)::text AS calculated,
              COUNT(l.id)::text AS entries,
              (COUNT(l.id) FILTER (WHERE l.currency <> w.currency))::text AS foreign_entries
       FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
       WHERE w.id = ? GROUP BY w.id`,
      [walletId],
    );
    if (!row) return undefined;
    return {
      storedBalance: moneyFromColumn(row.stored, row.currency),
      calculatedBalance: moneyFromColumn(row.calculated, row.currency),
      entryCount: Number(row.entries),
      foreignCurrencyEntries: Number(row.foreign_entries),
    };
  }
}
