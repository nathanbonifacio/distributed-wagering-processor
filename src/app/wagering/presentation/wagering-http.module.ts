import { Module } from '@nestjs/common';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../shared/application/unit-of-work.port';
import type { WageringPersistence } from '../application/ports/wagering-persistence.port';
import { WagerTransactionQueries } from '../application/wager-transaction-queries';
import { WageringModule } from '../wagering.module';
import { WageringController } from './wagering.controller';
import { WalletOpeningController } from './wallet-opening.controller';

/** Só a API importa: o worker usa os casos de uso, mas não expõe rotas de negócio. */
@Module({
  imports: [WageringModule],
  controllers: [WageringController, WalletOpeningController],
  providers: [
    {
      provide: WagerTransactionQueries,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork<WageringPersistence>) => new WagerTransactionQueries(unitOfWork),
    },
  ],
})
export class WageringHttpModule {}
