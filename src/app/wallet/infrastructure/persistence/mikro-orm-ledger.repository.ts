import type { EntityManager } from '@mikro-orm/postgresql';
import { moneyFromColumn } from '../../../../shared/infrastructure/persistence/money-column';
import type { LedgerPage, LedgerRepository, LedgerTotals } from '../../application/ports/ledger.repository.port';
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
}
