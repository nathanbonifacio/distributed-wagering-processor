import { type EntityManager, type FilterQuery, LockMode } from '@mikro-orm/postgresql';
import type { WagerTransactionRepository } from '../../application/ports/wager-transaction.repository.port';
import { type WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction.entity';
import { wagerTransactionToDomain, wagerTransactionToRow } from './wager-transaction.mapper';
import { type WagerTransactionRow, WagerTransactionSchema } from './wager-transaction.schema';

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ id });
  }

  async findByIdForUpdate(id: string): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(
      WagerTransactionSchema,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, disableIdentityMap: true },
    );
    return row ? wagerTransactionToDomain(row) : undefined;
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, externalTransactionId });
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ idempotencyKey });
  }

  async findAppliedReversal(referenceTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.findOne({
      referenceTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
    });
  }

  async findDuePendingIds(now: Date, limit: number): Promise<string[]> {
    const rows = await this.em.find(
      WagerTransactionSchema,
      { status: WagerTransactionStatus.PendingReference, nextAttemptAt: { $lte: now } },
      { fields: ['id'], orderBy: { nextAttemptAt: 'asc' }, limit, disableIdentityMap: true },
    );
    return rows.map((row) => row.id);
  }

  async insertIfAbsent(transaction: WagerTransaction): Promise<boolean> {
    const result = await this.em
      .createQueryBuilder(WagerTransactionSchema)
      .insert(wagerTransactionToRow(transaction))
      .onConflict()
      .ignore()
      .execute('run');
    return result.affectedRows === 1;
  }

  async update(transaction: WagerTransaction): Promise<void> {
    const row = wagerTransactionToRow(transaction);
    const affected = await this.em.nativeUpdate(
      WagerTransactionSchema,
      { id: transaction.id },
      {
        status: row.status,
        referenceTransactionId: row.referenceTransactionId,
        failureCode: row.failureCode,
        observedBalance: row.observedBalance,
        observedBalanceCurrency: row.observedBalanceCurrency,
        attempts: row.attempts,
        nextAttemptAt: row.nextAttemptAt,
        processedAt: row.processedAt,
      },
    );
    if (affected !== 1) throw new Error(`transação ${transaction.id} não encontrada para atualizar`);
  }

  private async findOne(where: FilterQuery<WagerTransactionRow>): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(WagerTransactionSchema, where, { disableIdentityMap: true });
    return row ? wagerTransactionToDomain(row) : undefined;
  }
}
