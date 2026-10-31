import { Module } from '@nestjs/common';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../shared/application/unit-of-work.port';
import type { WalletPersistence } from '../application/ports/wallet-persistence.port';
import { WalletQueries } from '../application/wallet-queries';
import { WalletController } from './wallet.controller';

/** Só a API importa: o worker não expõe rotas de negócio. */
@Module({
  controllers: [WalletController],
  providers: [
    {
      provide: WalletQueries,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork<WalletPersistence>) => new WalletQueries(unitOfWork),
    },
  ],
})
export class WalletHttpModule {}
