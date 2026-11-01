import { Module } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SqsModule } from '../../messaging/infrastructure/sqs.module';
import { APP_CONFIG, type AppConfig } from '../../../shared/infrastructure/config.module';
import { ProcessWagerTransaction } from '../application/process-wager-transaction.use-case';
import { WageringModule } from '../wagering.module';
import { WagerQueueConsumer } from './wager-queue.consumer';

/** Só o worker importa. */
@Module({
  imports: [SqsModule, WageringModule],
  providers: [
    {
      provide: WagerQueueConsumer,
      inject: [SQSClient, ProcessWagerTransaction, APP_CONFIG],
      useFactory: (sqs: SQSClient, processWager: ProcessWagerTransaction, config: AppConfig) =>
        new WagerQueueConsumer(sqs, processWager, {
          inputQueueName: config.SQS_INPUT_QUEUE_NAME,
          dlqQueueName: config.SQS_DLQ_QUEUE_NAME,
          batchSize: config.SQS_CONSUMER_BATCH_SIZE,
          waitSeconds: config.SQS_CONSUMER_WAIT_SECONDS,
          retryBaseSeconds: config.SQS_CONSUMER_RETRY_BASE_SECONDS,
          shutdownTimeoutMs: config.SQS_CONSUMER_SHUTDOWN_TIMEOUT_MS,
        }),
    },
  ],
})
export class WagerConsumerModule {}
