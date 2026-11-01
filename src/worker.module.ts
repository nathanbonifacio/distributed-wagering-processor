import { type DynamicModule, Module } from '@nestjs/common';
import { HealthModule } from './app/health/health.module';
import { OutboxPublisherModule } from './app/messaging/infrastructure/outbox-publisher.module';
import { PendingReferenceRetrierModule } from './app/wagering/infrastructure/pending-reference-retrier.module';
import { WagerConsumerModule } from './app/wagering/infrastructure/wager-consumer.module';
import { WageringModule } from './app/wagering/wagering.module';
import { PersistenceModule } from './persistence.module';
import { ConfigModule } from './shared/infrastructure/config.module';
import { ObservabilityModule } from './shared/observability/observability.module';

/** Expõe health, consome a fila de entrada, publica a outbox e retoma as referências pendentes. */
@Module({})
export class WorkerModule {
  /** `env` explícito permite aos testes subir o worker real em um banco descartável. */
  static register(env: Record<string, string | undefined> = process.env): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        ConfigModule.register(env),
        ObservabilityModule,
        PersistenceModule,
        WageringModule,
        WagerConsumerModule,
        OutboxPublisherModule,
        PendingReferenceRetrierModule,
        HealthModule,
      ],
    };
  }
}
