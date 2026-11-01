import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { type BeforeApplicationShutdown, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { InboxMessageConflictError } from '../../messaging/domain/inbox-message';
import { WalletNotFoundError } from '../../wallet/domain/wallet-errors';
import { InvalidMoneyError } from '../../../shared/domain/money';
import type { ProcessWagerTransaction } from '../application/process-wager-transaction.use-case';
import { wagerMessageSchema } from '../application/wager-message.schema';
import { WagerTransactionStatus } from '../domain/wager-transaction.entity';
import { IdempotencyConflictError, InvalidWagerTransactionError } from '../domain/wagering-errors';
import { PermanentInfrastructureError } from '../../../shared/application/infrastructure-error';
import { runWithContext } from '../../../shared/application/request-context';
import type { AppMetrics } from '../../../shared/observability/app-metrics';

export const WAGER_CONSUMER_NAME = 'wager-transactions-consumer';

const MAX_VISIBILITY_SECONDS = 300;
const RECEIVE_ERROR_DELAY_MS = 1000;
/** A leitura da profundidade da DLQ não pode travar a coleta das métricas. */
const DLQ_DEPTH_TIMEOUT_MS = 2000;

export interface WagerConsumerOptions {
  inputQueueName: string;
  dlqQueueName: string;
  batchSize: number;
  waitSeconds: number;
  retryBaseSeconds: number;
  shutdownTimeoutMs: number;
}

type HandleOutcome = 'done' | 'retry';

/** Repetir não adianta. Sem efeito gravado, um ack perderia a mensagem: vai para a DLQ. */
function permanentFailureCode(error: unknown): string | undefined {
  if (error instanceof IdempotencyConflictError || error instanceof InboxMessageConflictError || error instanceof WalletNotFoundError) {
    return error.code;
  }
  if (error instanceof InvalidWagerTransactionError || error instanceof InvalidMoneyError) return 'INVALID_MESSAGE';
  if (error instanceof PermanentInfrastructureError) return 'INTERNAL_ERROR';
  return undefined;
}

/**
 * Adaptador da fila de entrada para o mesmo caso de uso da API. O DeleteMessage é o ack e só ocorre depois
 * do commit: morrer antes dele gera redelivery, que o inbox e a idempotency key transformam em replay.
 *
 * Erro transitório ou inesperado não apaga a mensagem e adia a próxima entrega; o limite de tentativas é a
 * redrive policy da fila. A correção não depende do FIFO: a ordem por grupo dentro do lote é otimização.
 */
export class WagerQueueConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(WagerQueueConsumer.name);
  private readonly stopping = new AbortController();
  /** Mensagens que este processo começou e ainda não terminou: no prazo do shutdown, voltam para a fila. */
  private readonly inFlight = new Set<Message>();
  private running?: Promise<void>;
  private inputQueueUrl?: string;
  private dlqQueueUrl?: string;

  constructor(
    private readonly sqs: SQSClient,
    private readonly processWager: ProcessWagerTransaction,
    private readonly options: WagerConsumerOptions,
    private readonly metrics?: AppMetrics,
  ) {
    // Cobre também o redrive automático da fila, que este processo não vê passar.
    metrics?.gauge('wager_dlq_depth', 'Messages waiting in the dead letter queue.', () => this.dlqDepth());
  }

  onApplicationBootstrap(): void {
    this.running = this.pollUntilStopped();
  }

  /**
   * Para de receber e conclui o que está em andamento, dentro do prazo. Se o prazo vencer, devolve à fila o que
   * ainda não terminou, para outra instância assumir sem esperar a visibilidade expirar. Se aquela transação
   * ainda confirmar, a redelivery é um replay: o inbox e a idempotency key garantem um único efeito.
   */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'deadline'>((resolve) => { timer = setTimeout(() => resolve('deadline'), this.options.shutdownTimeoutMs); });
    const outcome = await Promise.race([this.running?.then(() => 'finished' as const), deadline]);
    clearTimeout(timer);
    if (outcome === 'deadline' && this.inFlight.size > 0) {
      this.logger.warn({ msg: 'shutdown deadline reached: returning in-flight messages to the queue', inFlight: this.inFlight.size });
      await Promise.all([...this.inFlight].map((message) => this.release(message)));
    }
  }

  private get stopped(): boolean {
    return this.stopping.signal.aborted;
  }

  private async pollUntilStopped(): Promise<void> {
    while (!this.stopped) {
      try {
        const queueUrl = await this.inputUrl();
        const { Messages = [] } = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: this.options.batchSize,
            WaitTimeSeconds: this.options.waitSeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
          }),
          { abortSignal: this.stopping.signal },
        );
        await this.processBatch(Messages);
      } catch (error) {
        if (this.stopped) return;
        this.logger.warn({ msg: 'failed to receive messages', error: error instanceof Error ? error.name : typeof error });
        await Bun.sleep(RECEIVE_ERROR_DELAY_MS);
      }
    }
  }

  /** Em ordem dentro do grupo, em paralelo entre grupos. */
  private async processBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId!;
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    await Promise.all([...groups.values()].map((group) => this.processGroup(group)));
  }

  /** Depois de uma falha, ou no encerramento, o resto do grupo volta para a fila, na mesma ordem. */
  private async processGroup(messages: Message[]): Promise<void> {
    let halted = false;
    for (const message of messages) {
      if (halted || this.stopped) await this.release(message);
      else halted = (await this.handle(message)) === 'retry';
    }
  }

  /** Todo log e todo evento da mensagem compartilham o messageId do envelope (ou o do SQS, se ele nem for lido). */
  private async handle(message: Message): Promise<HandleOutcome> {
    const parsed = this.parse(message);
    const id = parsed?.messageId ?? message.MessageId;
    this.inFlight.add(message);
    try {
      return await runWithContext({ correlationId: id, messageId: id }, () => this.handleMessage(message, parsed));
    } finally {
      this.inFlight.delete(message);
    }
  }

  private async handleMessage(message: Message, parsed: ReturnType<WagerQueueConsumer['parse']>): Promise<HandleOutcome> {
    if (!parsed) {
      await this.deadLetter(message, 'INVALID_MESSAGE');
      return 'done';
    }
    const { messageId, data } = parsed;
    try {
      const result = await this.processWager.execute(
        { ...data, correlationId: messageId, causationId: messageId },
        { consumerName: WAGER_CONSUMER_NAME, messageId },
      );
      // Redelivery de uma operação que já terminou em FAILED: nada a repetir, e precisa de atenção.
      if (result.status === WagerTransactionStatus.Failed) await this.deadLetter(message, 'INTERNAL_ERROR');
      else await this.ack(message);
      return 'done';
    } catch (error) {
      const code = permanentFailureCode(error);
      if (code) {
        await this.deadLetter(message, code);
        return 'done';
      }
      await this.retryLater(message);
      return 'retry';
    }
  }

  private parse(message: Message) {
    try {
      const result = wagerMessageSchema.safeParse(JSON.parse(message.Body ?? ''));
      return result.success ? result.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** Falhar aqui é seguro: a redelivery encontra o inbox e vira replay. */
  private async ack(message: Message): Promise<void> {
    try {
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: await this.inputUrl(), ReceiptHandle: message.ReceiptHandle! }));
    } catch (error) {
      this.logFailure('acknowledge', error);
    }
  }

  /** Só apaga depois de a DLQ aceitar: se o envio falhar, a mensagem volta e nada se perde. */
  private async deadLetter(message: Message, reason: string): Promise<void> {
    this.logger.warn({
      msg: 'moving message to the DLQ',
      reason,
      receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? 1),
    });
    try {
      this.dlqQueueUrl ??= (await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.options.dlqQueueName }))).QueueUrl!;
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: this.dlqQueueUrl,
          MessageBody: message.Body ?? '',
          MessageGroupId: message.Attributes?.MessageGroupId ?? message.MessageId,
          MessageDeduplicationId: message.MessageId,
          MessageAttributes: { failureReason: { DataType: 'String', StringValue: reason } },
        }),
      );
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: await this.inputUrl(), ReceiptHandle: message.ReceiptHandle! }));
      this.metrics?.dlqMessages.inc({ reason });
    } catch (error) {
      this.logFailure('move to the DLQ', error);
    }
  }

  private async retryLater(message: Message): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    const delaySeconds = Math.min(this.options.retryBaseSeconds * 2 ** (receiveCount - 1), MAX_VISIBILITY_SECONDS);
    this.metrics?.retries.inc({ kind: 'sqs_redelivery' });
    this.logger.warn({ msg: 'processing failed: redelivery scheduled', receiveCount, delaySeconds });
    await this.changeVisibility(message, delaySeconds);
  }

  private async release(message: Message): Promise<void> {
    await this.changeVisibility(message, 0);
  }

  /** Se falhar, a mensagem volta sozinha quando a visibilidade vencer. */
  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({ QueueUrl: await this.inputUrl(), ReceiptHandle: message.ReceiptHandle!, VisibilityTimeout: seconds }),
      );
    } catch (error) {
      this.logFailure('change visibility', error);
    }
  }

  private async dlqDepth(): Promise<number> {
    this.dlqQueueUrl ??= (await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.options.dlqQueueName }))).QueueUrl!;
    const { Attributes } = await this.sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: this.dlqQueueUrl, AttributeNames: ['ApproximateNumberOfMessages'] }),
      { abortSignal: AbortSignal.timeout(DLQ_DEPTH_TIMEOUT_MS) },
    );
    return Number(Attributes?.ApproximateNumberOfMessages ?? 0);
  }

  private async inputUrl(): Promise<string> {
    this.inputQueueUrl ??= (await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.options.inputQueueName }))).QueueUrl!;
    return this.inputQueueUrl;
  }

  /** Só o nome do erro: a mensagem pode trazer endereços internos. */
  private logFailure(action: string, error: unknown): void {
    this.logger.warn({ msg: `failed to ${action}`, error: error instanceof Error ? error.name : typeof error });
  }
}
