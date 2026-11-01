import type { Money } from '../../../shared/domain/money';
import { LedgerDirection } from '../../wallet/domain/ledger-entry.entity';
import type { Wallet } from '../../wallet/domain/wallet.entity';
import { FailureCode, isFailedCode, isRejectionCode } from './failure-code';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from './wagering-errors';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

/** Provider reservado às transações internas; nunca aceito na entrada. */
export const INTERNAL_PROVIDER_ID = 'internal';

/**
 * Transições válidas. PENDING_REFERENCE não volta a PENDING: a retomada decide direto a partir dele.
 * Terminais não têm saída. Enquanto a referência seguir ausente, a transação simplesmente permanece.
 */
const TRANSITIONS: Readonly<Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>> = {
  [WagerTransactionStatus.Pending]: [
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.PendingReference]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.Processed]: [],
  [WagerTransactionStatus.Rejected]: [],
  [WagerTransactionStatus.Failed]: [],
};

/** Referências aceitas por operação. BET não usa referência; OPENING é interno e não reversível. */
const ALLOWED_REFERENCE_KINDS: Readonly<Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface CreateOpeningTransactionProps {
  id: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  money: Money;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  /** Saldo observado ao decidir; é o que o replay devolve. Ausente enquanto não houver decisão. */
  observedBalance?: Money;
  processedAt?: Date;
  /** Tentativas já feitas de resolver a referência, e quando será a próxima. */
  attempts?: number;
  nextAttemptAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor, não o id interno. */
    public readonly referenceExternalTransactionId: string | undefined,
    private readonly _createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _observedBalance?: Money,
    private _processedAt?: Date,
    private _attempts: number = 0,
    private _nextAttemptAt?: Date,
  ) {}

  /** Operação externa. Nasce em PENDING e valida a exigência de referência por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError('OPENING is internal and cannot be submitted');
    }
    if (props.providerId === INTERNAL_PROVIDER_ID) {
      throw new InvalidWagerTransactionError(`the provider "${INTERNAL_PROVIDER_ID}" is reserved`);
    }
    return WagerTransaction.build(props);
  }

  /**
   * Transação interna de abertura. Campos derivados da wallet, sempre os mesmos para ela:
   * provider "internal"; externalTransactionId, idempotencyKey e roundId "opening:<walletId>"; gameId "internal".
   */
  static createOpening(props: CreateOpeningTransactionProps): WagerTransaction {
    const openingId = `opening:${props.walletId}`;
    return WagerTransaction.build({
      ...props,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: openingId,
      idempotencyKey: openingId,
      roundId: openingId,
      gameId: INTERNAL_PROVIDER_ID,
      kind: WagerTransactionKind.Opening,
    });
  }

  /** Reconstrução a partir da persistência: não revalida regras nem transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      new Date(state.createdAt),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.observedBalance,
      state.processedAt && new Date(state.processedAt),
      state.attempts ?? 0,
      state.nextAttemptAt && new Date(state.nextAttemptAt),
    );
  }

  private static build(props: CreateWagerTransactionProps): WagerTransaction {
    const required = [
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
    ];
    if (required.some((value) => !value)) {
      throw new InvalidWagerTransactionError('identifiers and payloadHash are required');
    }

    const reference = props.referenceExternalTransactionId;
    const allowedReferences = ALLOWED_REFERENCE_KINDS[props.kind];
    if ((props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback) && !reference) {
      throw new InvalidWagerTransactionError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (reference !== undefined && (!allowedReferences || !reference)) {
      throw new InvalidWagerTransactionError(`${props.kind} does not accept a reference`);
    }
    if (reference === props.externalTransactionId) {
      throw new InvalidWagerTransactionError('a transaction cannot reference itself');
    }

    // Interpretação: só LOSS pode ter valor zero, porque não move saldo.
    const validAmount = props.kind === WagerTransactionKind.Loss ? !props.money.isNegative() : props.money.isPositive();
    if (!validAmount) {
      throw new InvalidWagerTransactionError(`invalid amount for ${props.kind}`);
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      reference,
      new Date(props.createdAt),
      WagerTransactionStatus.Pending,
    );
  }

  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get processedAt(): Date | undefined {
    return this._processedAt && new Date(this._processedAt);
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt && new Date(this._nextAttemptAt);
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertCanTransitionTo(WagerTransactionStatus.Processed);
    if ((referenceTransactionId === undefined) !== (this.referenceExternalTransactionId === undefined)) {
      throw new InvalidTransactionStateError(
        `${this.id}: the internal reference id must accompany the external reference`,
      );
    }
    this._referenceTransactionId = referenceTransactionId;
    this._status = WagerTransactionStatus.Processed;
    this._processedAt = new Date(at);
    this._nextAttemptAt = undefined;
  }

  markPendingReference(): void {
    this.assertCanTransitionTo(WagerTransactionStatus.PendingReference);
    this._status = WagerTransactionStatus.PendingReference;
  }

  /**
   * Agenda a próxima tentativa de resolver a referência. O primeiro agendamento não conta como
   * tentativa; os seguintes sim. O prazo (backoff e limite) é decidido por quem chama.
   */
  scheduleReferenceRetry(nextAttemptAt: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(`${this.id}: only PENDING_REFERENCE is scheduled, not ${this._status}`);
    }
    if (this._nextAttemptAt) this._attempts += 1;
    this._nextAttemptAt = new Date(nextAttemptAt);
  }

  /** A última tentativa também conta: `attempts` registra quantas foram feitas até desistir. */
  expireReference(code: FailureCode, at: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(`${this.id}: only PENDING_REFERENCE can expire, not ${this._status}`);
    }
    this._attempts += 1;
    this.reject(code, at);
  }

  isReferenceRetryDue(now: Date): boolean {
    return (
      this._status === WagerTransactionStatus.PendingReference &&
      this._nextAttemptAt !== undefined &&
      this._nextAttemptAt.getTime() <= now.getTime()
    );
  }

  reject(code: FailureCode, at: Date): void {
    this.assertCanTransitionTo(WagerTransactionStatus.Rejected);
    if (!isRejectionCode(code)) {
      throw new InvalidTransactionStateError(`${code} is not a rejection code`);
    }
    this._failureCode = code;
    this._status = WagerTransactionStatus.Rejected;
    this._processedAt = new Date(at);
    this._nextAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertCanTransitionTo(WagerTransactionStatus.Failed);
    if (!isFailedCode(code)) {
      throw new InvalidTransactionStateError(`${code} is not an infrastructure failure code`);
    }
    this._failureCode = code;
    this._status = WagerTransactionStatus.Failed;
    this._processedAt = new Date(at);
    this._nextAttemptAt = undefined;
  }

  /** Registra o saldo visto na decisão, para a regra 7 (replay devolve o saldo da época). */
  recordObservedBalance(balance: Money): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`${this.id}: terminal state ${this._status} does not change`);
    }
    this._observedBalance = balance;
  }

  isTerminal(): boolean {
    return TRANSITIONS[this._status].length === 0;
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** ROLLBACK aplica o inverso da referência; os demais kinds têm direção própria. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError('LOSS does not produce a ledger entry');
      case WagerTransactionKind.Rollback:
        if (reference?.kind === WagerTransactionKind.Bet) return LedgerDirection.Credit;
        if (reference?.kind === WagerTransactionKind.Win || reference?.kind === WagerTransactionKind.Refund) {
          return LedgerDirection.Debit;
        }
        throw new InvalidTransactionStateError('ROLLBACK requires a reference to a BET, WIN or REFUND');
    }
  }

  /** Player e moeda precisam coincidir com a wallet. */
  validateWallet(wallet: Wallet): FailureCode | undefined {
    if (wallet.playerId !== this.playerId) return FailureCode.PlayerWalletMismatch;
    if (wallet.currency !== this.money.currency) return FailureCode.CurrencyMismatch;
    return undefined;
  }

  /**
   * Regras 2 a 5 do README. Uma referência ainda não decidida só é reprovada pelo que já não pode
   * mudar; cabe a quem chama aguardá-la. `existingReversal` é a reversão já registrada para a
   * referência: a decisão do projeto só permite uma, REFUND ou ROLLBACK, o que é mais estrito que a
   * regra 4 (que só proíbe repetir o tipo) e impede crédito duplicado. A garantia definitiva sob
   * concorrência é o índice único parcial do banco.
   */
  validateReference(reference: WagerTransaction, existingReversal?: WagerTransaction): FailureCode | undefined {
    if (
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.money.currency !== this.money.currency ||
      reference.roundId !== this.roundId
    ) {
      return FailureCode.ReferenceMismatch;
    }
    if (!ALLOWED_REFERENCE_KINDS[this.kind]?.includes(reference.kind)) {
      return FailureCode.ReferenceKindInvalid;
    }
    if (
      reference.status === WagerTransactionStatus.Rejected ||
      reference.status === WagerTransactionStatus.Failed
    ) {
      return FailureCode.ReferenceNotProcessed;
    }
    if (this.requiresReference()) {
      if (!this.money.equals(reference.money)) return FailureCode.AmountMismatch;
      if (existingReversal?.status === WagerTransactionStatus.Processed) return FailureCode.AlreadyReversed;
    }
    return undefined;
  }

  /** Códigos distintos: aposta sem saldo e reversão sem saldo são situações operacionais diferentes. */
  insufficientFundsCode(): FailureCode {
    return this.kind === WagerTransactionKind.Rollback
      ? FailureCode.ReversalInsufficientFunds
      : FailureCode.InsufficientFunds;
  }

  private assertCanTransitionTo(next: WagerTransactionStatus): void {
    if (!TRANSITIONS[this._status].includes(next)) {
      throw new InvalidTransactionStateError(`${this.id}: invalid transition from ${this._status} to ${next}`);
    }
  }
}
