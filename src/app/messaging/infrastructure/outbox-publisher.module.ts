import { Module } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { UnitOfWork } from '../../../shared/application/unit-of-work.port';
import { UNIT_OF_WORK } from '../../../shared/application/unit-of-work.port';
import { APP_CONFIG, type AppConfig } from '../../../shared/infrastructure/config.module';
import { systemClock } from '../../../shared/infrastructure/system-providers';
import { AppMetrics } from '../../../shared/observability/app-metrics';
import type { OutboxRepository } from '../application/ports/outbox.repository.port';
import { PublishOutboxBatch } from '../application/publish-outbox-batch.use-case';
import { OutboxPublisherLoop } from './outbox-publisher.loop';
import { SqsMessagePublisher } from './sqs-message-publisher';
import { SqsModule } from './sqs.module';

/** Folga sobre o prazo de publicação, para a reserva não vencer durante um envio normal. */
const LEASE_FACTOR = 6;

/** Lidos só na coleta, pelo índice parcial das pendentes. Cobrem toda a outbox, de qualquer publisher. */
function registerOutboxGauges(orm: MikroORM, metrics?: AppMetrics): void {
  const read = async (column: 'lag' | 'pending'): Promise<number> => {
    const [row] = await orm.em
      .fork()
      .getConnection()
      .execute<Array<{ lag: number; pending: number }>>(
        `SELECT COALESCE(EXTRACT(EPOCH FROM (now() - min(occurred_at))), 0)::float8 AS lag, count(*)::float8 AS pending
         FROM outbox_messages WHERE published_at IS NULL`,
      );
    return Number(row?.[column] ?? 0);
  };
  metrics?.gauge('wager_outbox_lag_seconds', 'Age of the oldest unpublished outbox event; 0 when none is pending.', () => read('lag'));
  metrics?.gauge('wager_outbox_pending', 'Outbox events not yet published.', () => read('pending'));
}

/** Só o worker importa. */
@Module({
  imports: [SqsModule],
  providers: [
    {
      provide: OutboxPublisherLoop,
      inject: [UNIT_OF_WORK, SQSClient, APP_CONFIG, MikroORM, { token: AppMetrics, optional: true }],
      useFactory: (
        unitOfWork: UnitOfWork<{ outbox: OutboxRepository }>,
        sqs: SQSClient,
        config: AppConfig,
        orm: MikroORM,
        metrics?: AppMetrics,
      ) => {
        registerOutboxGauges(orm, metrics);
        return new OutboxPublisherLoop(
          new PublishOutboxBatch(
            unitOfWork,
            new SqsMessagePublisher(sqs, config.SQS_EVENTS_QUEUE_NAME, config.OUTBOX_PUBLISH_TIMEOUT_MS),
            systemClock,
            { batchSize: config.OUTBOX_BATCH_SIZE, leaseMs: config.OUTBOX_PUBLISH_TIMEOUT_MS * LEASE_FACTOR },
          ),
          config.OUTBOX_BATCH_SIZE,
          config.OUTBOX_POLL_INTERVAL_MS,
          metrics,
        );
      },
    },
  ],
})
export class OutboxPublisherModule {}
