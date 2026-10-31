import type { Wallet } from '../../domain/wallet.entity';

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>;
  /** SELECT ... FOR UPDATE: trava a linha até o fim da transação e devolve o saldo já efetivado. */
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  insert(wallet: Wallet): Promise<void>;
  /** Grava saldo e versão só se a linha ainda estiver em `expectedVersion`; senão lança. */
  update(wallet: Wallet, expectedVersion: number): Promise<void>;
}
