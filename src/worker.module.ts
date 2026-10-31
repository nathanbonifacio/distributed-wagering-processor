import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { ConfigModule } from './shared/infrastructure/config.module';

/** Etapa 0: o worker só expõe health. Consumer, retrier e publisher entram nas etapas 8 a 10. */
@Module({ imports: [ConfigModule.register(), HealthModule] })
export class WorkerModule {}
