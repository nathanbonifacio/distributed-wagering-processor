import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  SQS_ENDPOINT: z.string().min(1),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  /** Opcionais: ausentes, o SDK usa a cadeia padrão de credenciais da AWS. */
  AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  WORKER_PORT: z.coerce.number().int().min(0).max(65535).default(3100),
  SQS_INPUT_QUEUE_NAME: z.string().min(1).default('wager-transactions.fifo'),
  SQS_EVENTS_QUEUE_NAME: z.string().min(1).default('wager-events'),
  SQS_DLQ_QUEUE_NAME: z.string().min(1).default('wager-transactions-dlq.fifo'),
  /** Mensagens por recebimento; grupos diferentes são processados em paralelo. */
  SQS_CONSUMER_BATCH_SIZE: z.coerce.number().int().min(1).max(10).default(10),
  SQS_CONSUMER_WAIT_SECONDS: z.coerce.number().int().min(0).max(20).default(10),
  /** Primeiro intervalo do retry de erro transitório; dobra a cada recebimento, até 5 minutos. */
  SQS_CONSUMER_RETRY_BASE_SECONDS: z.coerce.number().int().min(0).default(5),
  /** Espera pelas mensagens em andamento no encerramento. Abaixo dos 10 s do `docker stop`. */
  SQS_CONSUMER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(8000),
  /** Prazo de cada dependência no /health/ready. */
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(2000),
  /** Prazo para estabelecer conexão com o PostgreSQL (pool do driver). */
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).default(5000),
  /** Teto de duração de uma query no driver (cliente e servidor): rede de segurança, não regra de negócio. */
  DB_QUERY_TIMEOUT_MS: z.coerce.number().int().min(100).default(30000),
  /** Espera máxima por um lock dentro de uma transação; estourar é falha transitória. */
  DB_LOCK_TIMEOUT_MS: z.coerce.number().int().min(1).default(5000),
  /** Intervalo entre consultas da outbox quando não há lote cheio. */
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(10).default(1000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  /** Prazo de cada envio ao SQS. A reserva de um lote dura 6 vezes este valor. */
  OUTBOX_PUBLISH_TIMEOUT_MS: z.coerce.number().int().min(100).default(5000),
  /** Intervalo entre consultas de PENDING_REFERENCE vencidas quando não há lote cheio. */
  PENDING_REFERENCE_POLL_INTERVAL_MS: z.coerce.number().int().min(10).default(1000),
  PENDING_REFERENCE_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  /** Backoff min(base·2^n, teto) e limite de tentativas: por padrão, cerca de 25 minutos até desistir. */
  PENDING_REFERENCE_RETRY_BASE_MS: z.coerce.number().int().min(1).default(5000),
  PENDING_REFERENCE_RETRY_MAX_MS: z.coerce.number().int().min(1).default(300_000),
  PENDING_REFERENCE_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(10),
});

export type AppConfig = z.infer<typeof schema>;

/** Valida as variáveis de ambiente na subida; falha rápido com a lista de problemas. */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
