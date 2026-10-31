import { Module } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { SqsModule } from '../messaging/infrastructure/sqs.module';
import { APP_CONFIG, type AppConfig } from '../../shared/infrastructure/config.module';
import { DEPENDENCY_PROBES, type DependencyProbe } from './dependency-probe';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { PostgresProbe, SqsQueueProbe } from './probes';

@Module({
  imports: [SqsModule],
  controllers: [HealthController],
  providers: [
    {
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
