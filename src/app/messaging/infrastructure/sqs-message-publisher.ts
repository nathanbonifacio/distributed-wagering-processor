import { GetQueueUrlCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { withTimeout } from '../../../shared/infrastructure/with-timeout';
import type { MessagePublisher } from '../application/ports/message-publisher.port';
import type { OutboxMessage } from '../domain/outbox-message';

/**
 * Publica o envelope gravado na outbox (README, seção 11) na fila de eventos, nunca na de entrada: o
 * consumer receberia os próprios eventos. Em fila FIFO, o grupo é o agregado e a deduplicação é o eventId;
 * nada na correção financeira depende dessa ordem nem dessa deduplicação.
 */
export class SqsMessagePublisher implements MessagePublisher {
  private queueUrl?: string;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueName: string,
    private readonly timeoutMs: number,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    const fifo = this.queueName.endsWith('.fifo') ? { MessageGroupId: message.aggregateId, MessageDeduplicationId: message.id } : {};
    await withTimeout(async (abortSignal) => {
      const QueueUrl = await this.resolveQueueUrl(abortSignal);
      await this.sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: JSON.stringify(message.payload), ...fifo }), { abortSignal });
    }, this.timeoutMs);
  }

  private async resolveQueueUrl(abortSignal: AbortSignal): Promise<string> {
    this.queueUrl ??= (await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.queueName }), { abortSignal })).QueueUrl!;
    return this.queueUrl;
  }
}
