import { Module } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { DatabaseModule } from '../database/database.module';
import { SqsModule } from '../messaging/infrastructure/sqs.module';
import { APP_CONFIG, type AppConfig } from '../shared/infrastructure/config.module';
import { DEPENDENCY_PROBES, type DependencyProbe } from './dependency-probe';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { PostgresProbe, SqsQueueProbe } from './probes';

@Module({
  imports: [DatabaseModule, SqsModule],
  controllers: [HealthController],
  providers: [
    {
      // As probes não são providers: o factory as monta com as dependências já injetadas.
      // Para monitorar mais uma dependência, basta acrescentar uma probe a esta lista.
      provide: DEPENDENCY_PROBES,
      inject: [MikroORM, SQSClient, APP_CONFIG],
      useFactory: (orm: MikroORM, sqs: SQSClient, config: AppConfig): DependencyProbe[] => [
        new PostgresProbe(orm),
        new SqsQueueProbe('sqs', config.SQS_INPUT_QUEUE_NAME, sqs),
        new SqsQueueProbe('sqsEvents', config.SQS_EVENTS_QUEUE_NAME, sqs),
      ],
    },
    HealthService,
  ],
})
export class HealthModule {}
