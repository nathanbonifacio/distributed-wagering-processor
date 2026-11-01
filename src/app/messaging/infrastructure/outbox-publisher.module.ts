import { Module } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import type { UnitOfWork } from '../../../shared/application/unit-of-work.port';
import { UNIT_OF_WORK } from '../../../shared/application/unit-of-work.port';
import { APP_CONFIG, type AppConfig } from '../../../shared/infrastructure/config.module';
import { systemClock } from '../../../shared/infrastructure/system-providers';
import type { OutboxRepository } from '../application/ports/outbox.repository.port';
import { PublishOutboxBatch } from '../application/publish-outbox-batch.use-case';
import { OutboxPublisherLoop } from './outbox-publisher.loop';
import { SqsMessagePublisher } from './sqs-message-publisher';
import { SqsModule } from './sqs.module';

/** Folga sobre o prazo de publicação, para a reserva não vencer durante um envio normal. */
const LEASE_FACTOR = 6;

/** Só o worker importa. */
@Module({
  imports: [SqsModule],
  providers: [
    {
      provide: OutboxPublisherLoop,
      inject: [UNIT_OF_WORK, SQSClient, APP_CONFIG],
      useFactory: (unitOfWork: UnitOfWork<{ outbox: OutboxRepository }>, sqs: SQSClient, config: AppConfig) =>
        new OutboxPublisherLoop(
          new PublishOutboxBatch(
            unitOfWork,
            new SqsMessagePublisher(sqs, config.SQS_EVENTS_QUEUE_NAME, config.OUTBOX_PUBLISH_TIMEOUT_MS),
            systemClock,
            { batchSize: config.OUTBOX_BATCH_SIZE, leaseMs: config.OUTBOX_PUBLISH_TIMEOUT_MS * LEASE_FACTOR },
          ),
          config.OUTBOX_BATCH_SIZE,
          config.OUTBOX_POLL_INTERVAL_MS,
        ),
    },
  ],
})
export class OutboxPublisherModule {}
