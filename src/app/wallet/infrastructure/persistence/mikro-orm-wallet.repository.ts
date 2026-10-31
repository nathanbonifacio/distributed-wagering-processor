import { type EntityManager, LockMode } from '@mikro-orm/postgresql';
import { TransientInfrastructureError } from '../../../../shared/application/infrastructure-error';
import { moneyToColumn } from '../../../../shared/infrastructure/persistence/money-column';
import type { WalletRepository } from '../../application/ports/wallet.repository.port';
import type { Wallet } from '../../domain/wallet.entity';
import { walletToDomain, walletToRow } from './wallet.mapper';
import { WalletSchema } from './wallet.schema';

/**
 * Lê sempre com `disableIdentityMap` e escreve com comandos diretos: toda leitura vai ao banco, então
 * um saldo antigo em memória nunca decide nada, e a ordem do SQL é a ordem das chamadas.
 */
export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(WalletSchema, { id }, { disableIdentityMap: true });
    return row ? walletToDomain(row) : undefined;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(WalletSchema, { playerId, currency }, { disableIdentityMap: true });
    return row ? walletToDomain(row) : undefined;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(
      WalletSchema,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, disableIdentityMap: true },
    );
    return row ? walletToDomain(row) : undefined;
  }

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletSchema, walletToRow(wallet));
  }

  async update(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WalletSchema,
      { id: wallet.id, version: expectedVersion },
      { balance: moneyToColumn(wallet.balance), version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) {
      throw new TransientInfrastructureError(`wallet ${wallet.id} não está mais na versão ${expectedVersion}`);
    }
  }
}
