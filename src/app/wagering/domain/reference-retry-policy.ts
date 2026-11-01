export interface ReferenceRetryPolicyProps {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}

/** Backoff min(base·2^n, teto), em que n é o número de tentativas já feitas, e limite de tentativas. */
export class ReferenceRetryPolicy {
  private constructor(private readonly props: ReferenceRetryPolicyProps) {}

  static from(props: ReferenceRetryPolicyProps): ReferenceRetryPolicy {
    if (props.baseDelayMs <= 0 || props.maxDelayMs < props.baseDelayMs || props.maxAttempts < 1) {
      throw new Error('invalid reference retry policy');
    }
    return new ReferenceRetryPolicy(props);
  }

  /** Cinco segundos dobrando até 5 minutos, em 10 tentativas: cerca de 25 minutos no total. */
  static readonly DEFAULT = ReferenceRetryPolicy.from({ baseDelayMs: 5000, maxDelayMs: 300_000, maxAttempts: 10 });

  nextAttemptAt(attemptsMade: number, now: Date): Date {
    const delay = Math.min(this.props.baseDelayMs * 2 ** attemptsMade, this.props.maxDelayMs);
    return new Date(now.getTime() + delay);
  }

  isExhausted(attemptsMade: number): boolean {
    return attemptsMade >= this.props.maxAttempts;
  }
}
