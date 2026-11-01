import { Module } from '@nestjs/common';
import { UNIT_OF_WORK, type UnitOfWork } from '../../shared/application/unit-of-work.port';
import type { WalletPersistence } from './application/ports/wallet-persistence.port';
import { ReconcileWallet } from './application/reconcile-wallet.use-case';
import { LoggingReconciliationObserver } from './infrastructure/logging-reconciliation-observer';

/** Casos de uso da wallet que não são consultas. A API os importa; o módulo HTTP fica só com a apresentação. */
@Module({
  providers: [
    {
      provide: ReconcileWallet,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork<WalletPersistence>) =>
        new ReconcileWallet(unitOfWork, new LoggingReconciliationObserver()),
    },
  ],
  exports: [ReconcileWallet],
})
export class WalletModule {}
