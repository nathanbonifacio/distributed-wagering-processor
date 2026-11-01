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
});

export type AppConfig = z.infer<typeof schema>;

/** Valida as variáveis de ambiente na subida; falha rápido com a lista de problemas. */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuração inválida: ${issues}`);
  }
  return parsed.data;
}
