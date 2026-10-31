import { Module } from '@nestjs/common';
import { UNIT_OF_WORK, type UnitOfWork } from '../../shared/application/unit-of-work.port';
import { systemClock, uuidV7Generator } from '../../shared/infrastructure/system-providers';
import { OpenWallet } from './application/open-wallet.use-case';
import type { WageringPersistence } from './application/ports/wagering-persistence.port';
import { ProcessWagerTransaction } from './application/process-wager-transaction.use-case';
import { WagerProcessor } from './domain/wager-processor';

@Module({
  providers: [
    {
      provide: ProcessWagerTransaction,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork<WageringPersistence>) =>
        new ProcessWagerTransaction(unitOfWork, new WagerProcessor(), systemClock, uuidV7Generator),
    },
    {
      provide: OpenWallet,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork<WageringPersistence>) =>
        new OpenWallet(unitOfWork, new WagerProcessor(), systemClock, uuidV7Generator),
    },
  ],
  exports: [ProcessWagerTransaction, OpenWallet],
})
export class WageringModule {}
