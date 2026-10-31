import { Module } from '@nestjs/common';
import { HealthModule } from './app/health/health.module';
import { WageringModule } from './app/wagering/wagering.module';
import { PersistenceModule } from './persistence.module';
import { ConfigModule } from './shared/infrastructure/config.module';

/** O worker ainda só expõe health. Consumer, retrier e publisher entram nas etapas 8 a 10. */
@Module({ imports: [ConfigModule.register(), PersistenceModule, WageringModule, HealthModule] })
export class WorkerModule {}
