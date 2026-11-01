import { Module } from '@nestjs/common';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../shared/application/unit-of-work.port';
import { APP_CONFIG, type AppConfig } from '../../../shared/infrastructure/config.module';
import { systemClock } from '../../../shared/infrastructure/system-providers';
import type { WageringPersistence } from '../application/ports/wagering-persistence.port';
import { ProcessWagerTransaction } from '../application/process-wager-transaction.use-case';
import { RetryPendingReferences } from '../application/retry-pending-references.use-case';
import { WageringModule } from '../wagering.module';
import { PendingReferenceRetrierLoop } from './pending-reference-retrier.loop';

/** Só o worker importa. */
@Module({
  imports: [WageringModule],
  providers: [
    {
      provide: PendingReferenceRetrierLoop,
      inject: [UNIT_OF_WORK, ProcessWagerTransaction, APP_CONFIG],
      useFactory: (unitOfWork: UnitOfWork<WageringPersistence>, processWager: ProcessWagerTransaction, config: AppConfig) =>
        new PendingReferenceRetrierLoop(
          new RetryPendingReferences(unitOfWork, processWager, systemClock, config.PENDING_REFERENCE_BATCH_SIZE),
          config.PENDING_REFERENCE_BATCH_SIZE,
          config.PENDING_REFERENCE_POLL_INTERVAL_MS,
        ),
    },
  ],
})
export class PendingReferenceRetrierModule {}
