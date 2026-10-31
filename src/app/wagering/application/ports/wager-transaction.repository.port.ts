import type { WagerTransaction } from '../../domain/wager-transaction.entity';

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  /** Trava a linha; usado pelo retrier depois de travar a wallet. */
  findByIdForUpdate(id: string): Promise<WagerTransaction | undefined>;
  /** Também resolve referências: (providerId, referenceExternalTransactionId). */
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  /** A reversão já aplicada à operação original, se houver. */
  findAppliedReversal(referenceTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Ids das PENDING_REFERENCE vencidas, das mais antigas para as mais novas. */
  findDuePendingIds(now: Date, limit: number): Promise<string[]>;
  /**
   * true se gravou; false se esbarrou em uma chave única (idempotência, id externo ou reversão).
   * Não aborta a transação, então quem chama pode reler e decidir entre replay e conflito.
   */
  insertIfAbsent(transaction: WagerTransaction): Promise<boolean>;
  /** Grava o que muda depois de criada: estado, decisão e agendamento. */
  update(transaction: WagerTransaction): Promise<void>;
}
