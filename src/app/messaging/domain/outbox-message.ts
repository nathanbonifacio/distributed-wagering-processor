import { ProgrammingError } from '../../../shared/domain/programming-error';
import type { IntegrationEvent } from './integration-event';

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 5 * 60 * 1000;

export class InvalidOutboxTransitionError extends ProgrammingError {
  readonly code = 'INVALID_OUTBOX_TRANSITION';
}

/** O que a linha tinha quando foi lida: a base de comparação para gravar de volta sem sobrescrever outra reserva. */
export interface PersistedOutboxState {
  readonly attempts: number;
  readonly nextAttemptAt: Date;
}

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt?: Date;
  lastError?: string;
}

/** Evento a publicar. O id é o eventId, estável entre tentativas: é por ele que o consumidor deduplica. */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    private readonly _occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date,
    private _publishedAt?: Date,
    private _lastError?: string,
    private readonly _persistedState?: PersistedOutboxState,
  ) {}

  /** Nasce pronto para o publisher. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(event.eventId, event.aggregateId, event.eventType, { ...event.toJSON() }, event.occurredAt, 0, event.occurredAt);
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      new Date(state.occurredAt),
      state.attempts,
      new Date(state.nextAttemptAt),
      state.publishedAt && new Date(state.publishedAt),
      state.lastError,
      { attempts: state.attempts, nextAttemptAt: new Date(state.nextAttemptAt) },
    );
  }

  /** Ausente em quem nasceu de `enqueue`: nunca foi lido da tabela. Imutável, ao contrário de `attempts` e `nextAttemptAt`. */
  get persistedState(): PersistedOutboxState | undefined {
    return this._persistedState && { attempts: this._persistedState.attempts, nextAttemptAt: new Date(this._persistedState.nextAttemptAt) };
  }

  get occurredAt(): Date {
    return new Date(this._occurredAt);
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date {
    return new Date(this._nextAttemptAt);
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt && new Date(this._publishedAt);
  }

  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    this.assertPending();
    this._publishedAt = new Date(at);
  }

  /** Backoff min(1s·2^n, 5min), sem limite de tentativas: um evento confirmado não pode ser perdido. */
  scheduleRetry(now: Date, error?: string): void {
    this.assertPending();
    const delay = Math.min(RETRY_BASE_MS * 2 ** this._attempts, RETRY_MAX_MS);
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + delay);
    this._lastError = error;
  }

  /** Sucesso atrasado também vale: o evento saiu. Se outra tentativa já confirmou, fica a primeira data. */
  confirmPublished(at: Date): void {
    if (this.isPending()) this.markPublished(at);
  }

  /**
   * Resultado de uma tentativa que reservou até `leaseUntil`. `attempts` conta falhas de publicação, inclusive
   * as atrasadas, mas só a reserva vigente reagenda. `nextAttemptAt` serve de token: a linha só é reservada
   * quando vencida e a reserva nova vale `agora + lease`, então um token já substituído nunca volta a coincidir.
   */
  registerFailure(leaseUntil: Date, now: Date, error?: string): void {
    if (!this.isPending()) return;
    if (this._nextAttemptAt.getTime() === leaseUntil.getTime()) {
      this.scheduleRetry(now, error);
      return;
    }
    this._attempts += 1;
    this._lastError = error;
  }

  private assertPending(): void {
    if (!this.isPending()) throw new InvalidOutboxTransitionError(`event ${this.id} was already published`);
  }
}
