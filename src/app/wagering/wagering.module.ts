import { Module } from '@nestjs/common';
import { UNIT_OF_WORK, type UnitOfWork } from '../../shared/application/unit-of-work.port';
import { APP_CONFIG, type AppConfig } from '../../shared/infrastructure/config.module';
import { systemClock, uuidV7Generator } from '../../shared/infrastructure/system-providers';
import { OpenWallet } from './application/open-wallet.use-case';
import type { WageringPersistence } from './application/ports/wagering-persistence.port';
import { ProcessWagerTransaction } from './application/process-wager-transaction.use-case';
import { ReferenceRetryPolicy } from './domain/reference-retry-policy';
import { WagerProcessor } from './domain/wager-processor';
import { ObservedWagerTelemetry } from './infrastructure/wager-telemetry';
import { AppMetrics } from '../../shared/observability/app-metrics';

@Module({
  providers: [
    {
      provide: ProcessWagerTransaction,
      inject: [UNIT_OF_WORK, APP_CONFIG, { token: AppMetrics, optional: true }],
      useFactory: (unitOfWork: UnitOfWork<WageringPersistence>, config: AppConfig, metrics?: AppMetrics) =>
        new ProcessWagerTransaction(
          unitOfWork,
          new WagerProcessor(),
          systemClock,
          uuidV7Generator,
          ReferenceRetryPolicy.from({
            baseDelayMs: config.PENDING_REFERENCE_RETRY_BASE_MS,
            maxDelayMs: config.PENDING_REFERENCE_RETRY_MAX_MS,
            maxAttempts: config.PENDING_REFERENCE_MAX_ATTEMPTS,
          }),
          metrics ? new ObservedWagerTelemetry(metrics) : undefined,
        ),
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
