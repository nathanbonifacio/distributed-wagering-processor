import { Module } from '@nestjs/common';
import { type EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { InboxMessageSchema } from './app/messaging/infrastructure/persistence/inbox-message.schema';
import { MikroOrmInboxRepository } from './app/messaging/infrastructure/persistence/mikro-orm-inbox.repository';
import { MikroOrmOutboxRepository } from './app/messaging/infrastructure/persistence/mikro-orm-outbox.repository';
import { OutboxMessageSchema } from './app/messaging/infrastructure/persistence/outbox-message.schema';
import type { WageringPersistence } from './app/wagering/application/ports/wagering-persistence.port';
import { MikroOrmWagerTransactionRepository } from './app/wagering/infrastructure/persistence/mikro-orm-wager-transaction.repository';
import { WagerTransactionSchema } from './app/wagering/infrastructure/persistence/wager-transaction.schema';
import { LedgerEntrySchema } from './app/wallet/infrastructure/persistence/ledger-entry.schema';
import { MikroOrmLedgerRepository } from './app/wallet/infrastructure/persistence/mikro-orm-ledger.repository';
import { MikroOrmWalletRepository } from './app/wallet/infrastructure/persistence/mikro-orm-wallet.repository';
import { WalletSchema } from './app/wallet/infrastructure/persistence/wallet.schema';
import { DatabaseModule } from './database/database.module';
import { MikroOrmUnitOfWork } from './database/mikro-orm-unit-of-work';
import { UNIT_OF_WORK } from './shared/application/unit-of-work.port';
import { APP_CONFIG, type AppConfig } from './shared/infrastructure/config.module';

export const PERSISTENCE_SCHEMAS = [
  WalletSchema,
  LedgerEntrySchema,
  WagerTransactionSchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];

export function createPersistenceContext(em: EntityManager): WageringPersistence {
  return {
    wallets: new MikroOrmWalletRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}

/**
 * Raiz de composição da persistência: é o único lugar que conhece as implementações. Os use cases
 * dependem do token UNIT_OF_WORK e dos ports, e cada módulo continua sem importar a infraestrutura do outro.
 */
@Module({
  imports: [DatabaseModule.forRoot(PERSISTENCE_SCHEMAS)],
  providers: [
    {
      provide: UNIT_OF_WORK,
      inject: [MikroORM, APP_CONFIG],
      useFactory: (orm: MikroORM, config: AppConfig) =>
        new MikroOrmUnitOfWork(orm, createPersistenceContext, config.DB_LOCK_TIMEOUT_MS),
    },
  ],
  exports: [UNIT_OF_WORK],
})
export class PersistenceModule {}
