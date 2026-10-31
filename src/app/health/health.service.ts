import { Inject, Injectable, Logger } from '@nestjs/common';
import { TimeoutError, withTimeout } from '../../shared/infrastructure/with-timeout';
import { APP_CONFIG, type AppConfig } from '../../shared/infrastructure/config.module';
import { DEPENDENCY_PROBES, type DependencyProbe } from './dependency-probe';

/** Resposta PÚBLICA: só categorias genéricas. O detalhe do erro fica no log interno. */
export interface DependencyStatus {
  status: 'up' | 'down';
  latencyMs: number;
  /** Só em 'down'. */
  reason?: 'timeout' | 'unavailable';
}

export interface ReadinessReport {
  status: 'ok' | 'unavailable';
  checks: Record<string, DependencyStatus>;
}

/** Remove credenciais de URLs (`scheme://user:senha@host` → `scheme://***@host`) antes de logar. */
export function redactSecrets(message: string): string {
  return message.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@');
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private inflight?: Promise<ReadinessReport>;

  constructor(
    @Inject(DEPENDENCY_PROBES) private readonly probes: readonly DependencyProbe[],
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'HEALTH_CHECK_TIMEOUT_MS'>,
  ) {}

  /**
   * Chamadas concorrentes compartilham a verificação em andamento (single-flight): um balanceador
   * que consulta o /ready com frequência, ou um alvo pendurado, nunca empilha verificações.
   */
  checkReadiness(): Promise<ReadinessReport> {
    this.inflight ??= this.checkAll().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /** Verifica todas as dependências em paralelo; cada uma com seu próprio prazo. */
  private async checkAll(): Promise<ReadinessReport> {
    const results = await Promise.all(this.probes.map((p) => this.run(p)));
    const checks = Object.fromEntries(results.map(([name, status]) => [name, status]));
    const allUp = results.every(([, s]) => s.status === 'up');
    return { status: allUp ? 'ok' : 'unavailable', checks };
  }

  private async run(probe: DependencyProbe): Promise<[string, DependencyStatus]> {
    const startedAt = performance.now();
    const elapsed = () => Math.round(performance.now() - startedAt);
    try {
      await withTimeout((signal) => probe.check(signal), this.config.HEALTH_CHECK_TIMEOUT_MS);
      return [probe.name, { status: 'up', latencyMs: elapsed() }];
    } catch (err) {
      const reason = err instanceof TimeoutError ? 'timeout' : 'unavailable';
      const detail = redactSecrets(err instanceof Error ? err.message : String(err));
      this.logger.warn(`readiness: dependência "${probe.name}" indisponível (${reason}): ${detail}`);
      return [probe.name, { status: 'down', latencyMs: elapsed(), reason }];
    }
  }
}
