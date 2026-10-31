import { GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { DependencyProbe } from './dependency-probe';

export class PostgresProbe implements DependencyProbe {
  readonly name = 'postgres';

  constructor(private readonly orm: MikroORM) {}

  async check(): Promise<void> {
    await this.orm.em.fork().getConnection().execute('select 1');
  }
}

/**
 * Verifica que uma fila SQS existe e está legível, usando só chamadas de metadados
 * (GetQueueUrl + GetQueueAttributes). Não envia, recebe, apaga nem altera visibilidade de mensagens.
 */
export class SqsQueueProbe implements DependencyProbe {
  constructor(
    /** Chave no relatório de readiness (ex.: 'sqs', 'sqsEvents'). */
    readonly name: string,
    private readonly queueName: string,
    private readonly sqs: SQSClient,
  ) {}

  async check(signal: AbortSignal): Promise<void> {
    const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.queueName }), {
      abortSignal: signal,
    });
    await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }), {
      abortSignal: signal,
    });
  }
}
