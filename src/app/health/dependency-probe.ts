/** Uma dependência externa cuja disponibilidade o readiness precisa conhecer. */
export interface DependencyProbe {
  readonly name: string;
  /** Resolve se a dependência está acessível; rejeita caso contrário. Respeita o signal. */
  check(signal: AbortSignal): Promise<void>;
}

/** Token do conjunto de probes: o HealthService não conhece PostgreSQL nem SQS. */
export const DEPENDENCY_PROBES = Symbol('DEPENDENCY_PROBES');
