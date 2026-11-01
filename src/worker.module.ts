import { type DynamicModule, Module } from '@nestjs/common';
import { HealthModule } from './app/health/health.module';
import { OutboxPublisherModule } from './app/messaging/infrastructure/outbox-publisher.module';
import { WageringModule } from './app/wagering/wagering.module';
import { PersistenceModule } from './persistence.module';
import { ConfigModule } from './shared/infrastructure/config.module';

/** Expõe health e publica a outbox. Consumer e retrier entram nas etapas 9 e 10. */
@Module({})
export class WorkerModule {
  /** `env` explícito permite aos testes subir o worker real em um banco descartável. */
  static register(env: Record<string, string | undefined> = process.env): DynamicModule {
    return {
      module: WorkerModule,
      imports: [ConfigModule.register(env), PersistenceModule, WageringModule, OutboxPublisherModule, HealthModule],
    };
  }
}
