/**
 * Configuração dos testes de integração, sem mutar process.env (global ao processo).
 * Bun carrega o .env sozinho; os fallbacks coincidem com o .env.example (endereços do host).
 */
export function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering',
    SQS_ENDPOINT: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    AWS_REGION: process.env.AWS_REGION ?? 'us-east-1',
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    HEALTH_CHECK_TIMEOUT_MS: '1500',
    ...overrides,
  };
}

/** Troca host:porta de uma URL (ex.: apontar o app para um proxy), preservando o resto. */
export function withHostPort(url: string, host: string, port: number): string {
  const u = new URL(url);
  u.hostname = host;
  u.port = String(port);
  return u.toString();
}
