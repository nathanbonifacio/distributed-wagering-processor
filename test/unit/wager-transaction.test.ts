import { describe, expect, test } from 'bun:test';
import { DomainError } from '../../src/shared/domain/domain-error';
import { ProgrammingError } from '../../src/shared/domain/programming-error';
import {
  InfrastructureError,
  PermanentInfrastructureError,
  TransientInfrastructureError,
} from '../../src/shared/application/infrastructure-error';
import { LedgerDirection } from '../../src/app/wallet/domain/ledger-entry.entity';
import { FailureCode, isFailedCode, isRejectionCode } from '../../src/app/wagering/domain/failure-code';
import {
  INTERNAL_PROVIDER_ID,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/app/wagering/domain/wager-transaction.entity';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from '../../src/app/wagering/domain/wagering-errors';
import { brl, newTx, openWallet, processedTx, T0, T1, T2, txProps, usd, WALLET_ID } from '../support/wagering-fixtures';

const REF = 'ext-ref';
const refund = (overrides = {}) => newTx(Kind.Refund, { referenceExternalTransactionId: REF, ...overrides });
const rollback = (overrides = {}) => newTx(Kind.Rollback, { referenceExternalTransactionId: REF, ...overrides });
const bet = (status: 'processed' | 'pending' = 'processed', overrides = {}) =>
  status === 'processed'
    ? processedTx(Kind.Bet, { externalTransactionId: REF, ...overrides })
    : newTx(Kind.Bet, { externalTransactionId: REF, ...overrides });

describe('create', () => {
  test.each([Kind.Bet, Kind.Win, Kind.Loss])('%s nasce PENDING sem referência', (kind) => {
    const tx = newTx(kind);
    expect(tx.status).toBe(Status.Pending);
    expect(tx.kind).toBe(kind);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.processedAt).toBeUndefined();
    expect(tx.failureCode).toBeUndefined();
    expect(tx.observedBalance).toBeUndefined();
    expect(tx.referenceExternalTransactionId).toBeUndefined();
    expect(tx.createdAt).toEqual(T0);
  });

  test.each([Kind.Refund, Kind.Rollback])('%s exige referência', (kind) => {
    expect(() => newTx(kind)).toThrow(InvalidWagerTransactionError);
    expect(() => newTx(kind, { referenceExternalTransactionId: '' })).toThrow(InvalidWagerTransactionError);
    expect(newTx(kind, { referenceExternalTransactionId: REF }).status).toBe(Status.Pending);
  });

  test.each([Kind.Win, Kind.Loss])('%s aceita referência opcional', (kind) => {
    expect(newTx(kind, { referenceExternalTransactionId: REF }).referenceExternalTransactionId).toBe(REF);
  });

  test('BET não aceita referência', () => {
    expect(() => newTx(Kind.Bet, { referenceExternalTransactionId: REF })).toThrow(InvalidWagerTransactionError);
  });

  test('uma transação não referencia a si mesma', () => {
    expect(() => newTx(Kind.Refund, { externalTransactionId: REF, referenceExternalTransactionId: REF })).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test('OPENING e o provider reservado não entram como operação externa', () => {
    expect(() => newTx(Kind.Opening)).toThrow(InvalidWagerTransactionError);
    expect(() => newTx(Kind.Bet, { providerId: INTERNAL_PROVIDER_ID })).toThrow(InvalidWagerTransactionError);
  });

  test.each([Kind.Bet, Kind.Win])('%s rejeita valor zero e negativo', (kind) => {
    expect(() => newTx(kind, { money: brl('0.00') })).toThrow(InvalidWagerTransactionError);
    expect(() => newTx(kind, { money: brl('1.00').negate() })).toThrow(InvalidWagerTransactionError);
  });

  test('reversões rejeitam valor zero; LOSS aceita zero mas não negativo', () => {
    expect(() => refund({ money: brl('0.00') })).toThrow(InvalidWagerTransactionError);
    expect(() => rollback({ money: brl('0.00') })).toThrow(InvalidWagerTransactionError);
    expect(newTx(Kind.Loss, { money: brl('0.00') }).money.isZero()).toBe(true);
    expect(() => newTx(Kind.Loss, { money: brl('1.00').negate() })).toThrow(InvalidWagerTransactionError);
  });

  test.each(['id', 'providerId', 'externalTransactionId', 'idempotencyKey', 'payloadHash', 'walletId', 'playerId', 'roundId', 'gameId'])(
    'campo obrigatório: %s',
    (field) => {
      expect(() => WagerTransaction.create({ ...txProps(Kind.Bet), [field]: '' })).toThrow(InvalidWagerTransactionError);
    },
  );
});

describe('createOpening', () => {
  const opening = () =>
    WagerTransaction.createOpening({
      id: 'tx-open',
      payloadHash: 'hash-open',
      walletId: WALLET_ID,
      playerId: 'player-1',
      money: brl('100.00'),
      createdAt: T0,
    });

  test('campos internos são determinísticos', () => {
    const tx = opening();
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.status).toBe(Status.Pending);
    expect(tx.providerId).toBe('internal');
    expect(tx.gameId).toBe('internal');
    expect(tx.externalTransactionId).toBe(`opening:${WALLET_ID}`);
    expect(tx.idempotencyKey).toBe(`opening:${WALLET_ID}`);
    expect(tx.roundId).toBe(`opening:${WALLET_ID}`);
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(tx.affectsBalance()).toBe(true);
    expect(tx.requiresReference()).toBe(false);
  });

  test('exige valor positivo', () => {
    expect(() =>
      WagerTransaction.createOpening({
        id: 'tx-open',
        payloadHash: 'h',
        walletId: WALLET_ID,
        playerId: 'p',
        money: brl('0.00'),
        createdAt: T0,
      }),
    ).toThrow(InvalidWagerTransactionError);
  });
});

describe('transições', () => {
  test('PENDING → PROCESSED registra processedAt', () => {
    const tx = newTx(Kind.Bet);
    tx.markProcessed(undefined, T1);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.processedAt).toEqual(T1);
    expect(tx.isTerminal()).toBe(true);
    expect(tx.failureCode).toBeUndefined();
  });

  test('PENDING → PROCESSED guarda o id interno da referência', () => {
    const tx = refund();
    tx.markProcessed('tx-bet', T1);
    expect(tx.referenceTransactionId).toBe('tx-bet');
  });

  test('o id interno da referência precisa acompanhar a referência externa', () => {
    expect(() => refund().markProcessed(undefined, T1)).toThrow(InvalidTransactionStateError);
    expect(() => newTx(Kind.Bet).markProcessed('tx-x', T1)).toThrow(InvalidTransactionStateError);
  });

  test('PENDING → REJECTED guarda o código e processedAt', () => {
    const tx = newTx(Kind.Bet);
    tx.reject(FailureCode.InsufficientFunds, T1);
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.processedAt).toEqual(T1);
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING → FAILED guarda o código e processedAt', () => {
    const tx = newTx(Kind.Bet);
    tx.fail(FailureCode.InternalError, T1);
    expect(tx.status).toBe(Status.Failed);
    expect(tx.failureCode).toBe(FailureCode.InternalError);
    expect(tx.processedAt).toEqual(T1);
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING → PENDING_REFERENCE não é terminal e não tem processedAt', () => {
    const tx = refund();
    tx.markPendingReference();
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.processedAt).toBeUndefined();
  });

  test('retomada: PENDING_REFERENCE → PROCESSED', () => {
    const tx = refund();
    tx.markPendingReference();
    tx.markProcessed('tx-bet', T2);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe('tx-bet');
    expect(tx.processedAt).toEqual(T2);
  });

  test('retomada: PENDING_REFERENCE → REJECTED (referência nunca chegou)', () => {
    const tx = refund();
    tx.markPendingReference();
    tx.reject(FailureCode.ReferenceNotFound, T2);
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  test('retomada: PENDING_REFERENCE → FAILED', () => {
    const tx = refund();
    tx.markPendingReference();
    tx.fail(FailureCode.InternalError, T2);
    expect(tx.status).toBe(Status.Failed);
  });

  test('PENDING_REFERENCE não se repete: a transação apenas permanece', () => {
    const tx = refund();
    tx.markPendingReference();
    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
    expect(tx.status).toBe(Status.PendingReference);
  });

  const terminal: Array<[string, () => WagerTransaction]> = [
    ['PROCESSED', () => { const t = newTx(Kind.Bet); t.markProcessed(undefined, T1); return t; }],
    ['REJECTED', () => { const t = newTx(Kind.Bet); t.reject(FailureCode.InsufficientFunds, T1); return t; }],
    ['FAILED', () => { const t = newTx(Kind.Bet); t.fail(FailureCode.InternalError, T1); return t; }],
  ];
  test.each(terminal)('%s é terminal: nenhuma transição passa e o estado não muda', (status, build) => {
    const tx = build();
    expect(() => tx.markProcessed(undefined, T2)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
    expect(() => tx.reject(FailureCode.AlreadyReversed, T2)).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.InternalError, T2)).toThrow(InvalidTransactionStateError);
    expect(() => tx.recordObservedBalance(brl('1.00'))).toThrow(InvalidTransactionStateError);
    expect(tx.status).toBe(status as Status);
    expect(tx.processedAt).toEqual(T1);
  });

  test('reject só aceita códigos de negócio e fail só aceita código de infraestrutura', () => {
    expect(() => newTx(Kind.Bet).reject(FailureCode.InternalError, T1)).toThrow(InvalidTransactionStateError);
    expect(() => newTx(Kind.Bet).fail(FailureCode.InsufficientFunds, T1)).toThrow(InvalidTransactionStateError);
  });

  test('transição inválida é erro de programação com code estável', () => {
    const tx = newTx(Kind.Bet);
    tx.markProcessed(undefined, T1);
    try {
      tx.markProcessed(undefined, T2);
      throw new Error('deveria lançar');
    } catch (error) {
      expect(error).toBeInstanceOf(ProgrammingError);
      expect((error as InvalidTransactionStateError).code).toBe('INVALID_TRANSACTION_STATE');
    }
  });
});

describe('consultas', () => {
  test('affectsBalance é false só para LOSS', () => {
    expect(newTx(Kind.Loss).affectsBalance()).toBe(false);
    expect(newTx(Kind.Bet).affectsBalance()).toBe(true);
    expect(newTx(Kind.Win).affectsBalance()).toBe(true);
    expect(refund().affectsBalance()).toBe(true);
    expect(rollback().affectsBalance()).toBe(true);
  });

  test('requiresReference é true para REFUND e ROLLBACK', () => {
    expect(refund().requiresReference()).toBe(true);
    expect(rollback().requiresReference()).toBe(true);
    expect(newTx(Kind.Bet).requiresReference()).toBe(false);
    expect(newTx(Kind.Win).requiresReference()).toBe(false);
    expect(newTx(Kind.Loss).requiresReference()).toBe(false);
  });

  test('matchesPayload compara o hash: mesma key com payload diferente não é replay', () => {
    const tx = newTx(Kind.Bet, { payloadHash: 'abc' });
    expect(tx.matchesPayload('abc')).toBe(true);
    expect(tx.matchesPayload('abd')).toBe(false);
  });

  test('ledgerDirectionFor por kind', () => {
    expect(newTx(Kind.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(newTx(Kind.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund().ledgerDirectionFor(bet())).toBe(LedgerDirection.Credit);
    expect(() => newTx(Kind.Loss).ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });

  test('ledgerDirectionFor em ROLLBACK é o inverso da referência', () => {
    expect(rollback().ledgerDirectionFor(newTx(Kind.Bet))).toBe(LedgerDirection.Credit);
    expect(rollback().ledgerDirectionFor(newTx(Kind.Win))).toBe(LedgerDirection.Debit);
    expect(rollback().ledgerDirectionFor(refund())).toBe(LedgerDirection.Debit);
    expect(() => rollback().ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
    expect(() => rollback().ledgerDirectionFor(newTx(Kind.Loss))).toThrow(InvalidTransactionStateError);
    expect(() => rollback().ledgerDirectionFor(rollback({ externalTransactionId: 'other' }))).toThrow(InvalidTransactionStateError);
  });

  test('insufficientFundsCode distingue aposta de reversão', () => {
    expect(newTx(Kind.Bet).insufficientFundsCode()).toBe(FailureCode.InsufficientFunds);
    expect(rollback().insufficientFundsCode()).toBe(FailureCode.ReversalInsufficientFunds);
  });

  test('validateWallet confere player e moeda', () => {
    const wallet = openWallet();
    expect(newTx(Kind.Bet).validateWallet(wallet)).toBeUndefined();
    expect(newTx(Kind.Bet, { playerId: 'outro' }).validateWallet(wallet)).toBe(FailureCode.PlayerWalletMismatch);
    expect(newTx(Kind.Bet, { money: usd('1.00') }).validateWallet(wallet)).toBe(FailureCode.CurrencyMismatch);
  });
});

describe('validateReference', () => {
  test('referência coerente passa', () => {
    expect(refund().validateReference(bet())).toBeUndefined();
  });

  test.each([
    ['provider', { providerId: 'provider-b' }],
    ['player', { playerId: 'player-2' }],
    ['wallet', { walletId: 'wallet-2' }],
    ['moeda', { money: usd('25.00') }],
    ['rodada', { roundId: 'round-2' }],
  ])('%s diferente: REFERENCE_MISMATCH', (_label, overrides) => {
    expect(refund().validateReference(bet('processed', overrides))).toBe(FailureCode.ReferenceMismatch);
  });

  test('gameId diferente é aceito: a regra 2 não o lista', () => {
    expect(refund().validateReference(bet('processed', { gameId: 'outro-jogo' }))).toBeUndefined();
  });

  test('referência REJECTED ou FAILED: REFERENCE_NOT_PROCESSED', () => {
    const rejected = bet('pending');
    rejected.reject(FailureCode.InsufficientFunds, T1);
    const failed = bet('pending');
    failed.fail(FailureCode.InternalError, T1);
    expect(refund().validateReference(rejected)).toBe(FailureCode.ReferenceNotProcessed);
    expect(refund().validateReference(failed)).toBe(FailureCode.ReferenceNotProcessed);
  });

  test('referência ainda não decidida não é reprovada por isso', () => {
    expect(refund().validateReference(bet('pending'))).toBeUndefined();
  });

  test('valor diferente: AMOUNT_MISMATCH nas reversões, livre em WIN', () => {
    expect(refund({ money: brl('24.99') }).validateReference(bet())).toBe(FailureCode.AmountMismatch);
    expect(rollback({ money: brl('25.01') }).validateReference(bet())).toBe(FailureCode.AmountMismatch);
    expect(newTx(Kind.Win, { referenceExternalTransactionId: REF, money: brl('500.00') }).validateReference(bet())).toBeUndefined();
  });

  test('reversão já processada: ALREADY_REVERSED, para o mesmo tipo e para o outro', () => {
    const reversal = (kind: Kind) =>
      processedTx(kind, { externalTransactionId: 'ext-earlier', referenceExternalTransactionId: REF });
    expect(refund().validateReference(bet(), reversal(Kind.Refund))).toBe(FailureCode.AlreadyReversed);
    expect(refund().validateReference(bet(), reversal(Kind.Rollback))).toBe(FailureCode.AlreadyReversed);
    expect(rollback().validateReference(bet(), reversal(Kind.Refund))).toBe(FailureCode.AlreadyReversed);
    expect(rollback().validateReference(bet(), reversal(Kind.Rollback))).toBe(FailureCode.AlreadyReversed);
  });

  test('reversão anterior rejeitada não impede uma nova', () => {
    const earlier = refund({ externalTransactionId: 'ext-earlier' });
    earlier.reject(FailureCode.AmountMismatch, T1);
    expect(refund().validateReference(bet(), earlier)).toBeUndefined();
  });

  test('tipos de referência aceitos por operação', () => {
    const win = processedTx(Kind.Win, { externalTransactionId: REF });
    const loss = processedTx(Kind.Loss, { externalTransactionId: REF });
    const invalid = FailureCode.ReferenceKindInvalid;
    expect(refund().validateReference(win)).toBe(invalid);
    expect(refund().validateReference(loss)).toBe(invalid);
    expect(rollback().validateReference(win)).toBeUndefined();
    expect(rollback().validateReference(loss)).toBe(invalid);
    expect(newTx(Kind.Win, { referenceExternalTransactionId: REF }).validateReference(win)).toBe(invalid);
    expect(newTx(Kind.Loss, { referenceExternalTransactionId: REF }).validateReference(bet())).toBeUndefined();
  });
});

describe('rehydrate', () => {
  test('reconstrói estado terminal sem passar pelas transições', () => {
    const tx = WagerTransaction.rehydrate({
      ...txProps(Kind.Refund, { referenceExternalTransactionId: REF }),
      status: Status.Rejected,
      failureCode: FailureCode.AlreadyReversed,
      observedBalance: brl('7.00'),
      processedAt: T1,
    });
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.AlreadyReversed);
    expect(tx.observedBalance?.equals(brl('7.00'))).toBe(true);
    expect(tx.processedAt).toEqual(T1);
    expect(tx.isTerminal()).toBe(true);
  });

  test('não revalida regras de criação: aceita OPENING interno e referência já resolvida', () => {
    const tx = WagerTransaction.rehydrate({
      ...txProps(Kind.Opening, { providerId: INTERNAL_PROVIDER_ID }),
      status: Status.Processed,
      referenceTransactionId: 'tx-x',
      processedAt: T1,
    });
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.referenceTransactionId).toBe('tx-x');
  });

  test('reidratada em PENDING_REFERENCE pode ser retomada', () => {
    const tx = WagerTransaction.rehydrate({
      ...txProps(Kind.Refund, { referenceExternalTransactionId: REF }),
      status: Status.PendingReference,
    });
    expect(tx.observedBalance).toBeUndefined();
    tx.markProcessed('tx-bet', T2);
    expect(tx.status).toBe(Status.Processed);
  });

  test('alterar Date exposto não afeta a transação', () => {
    const tx = newTx(Kind.Bet);
    tx.markProcessed(undefined, T1);
    tx.processedAt!.setFullYear(2000);
    tx.createdAt.setFullYear(2000);
    expect(tx.processedAt).toEqual(T1);
    expect(tx.createdAt).toEqual(T0);
  });
});

describe('taxonomia de erros', () => {
  test('todo código pertence a exatamente uma categoria; só INTERNAL_ERROR é de infraestrutura', () => {
    for (const code of Object.values(FailureCode)) {
      expect(isRejectionCode(code)).toBe(!isFailedCode(code));
    }
    expect(Object.values(FailureCode).filter(isFailedCode)).toEqual([FailureCode.InternalError]);
  });

  test('os valores dos códigos são estáveis', () => {
    expect(Object.values<string>(FailureCode).sort()).toEqual([
      'ALREADY_REVERSED',
      'AMOUNT_MISMATCH',
      'BALANCE_LIMIT_EXCEEDED',
      'CURRENCY_MISMATCH',
      'INSUFFICIENT_FUNDS',
      'INTERNAL_ERROR',
      'PLAYER_WALLET_MISMATCH',
      'REFERENCE_KIND_INVALID',
      'REFERENCE_MISMATCH',
      'REFERENCE_NOT_FOUND',
      'REFERENCE_NOT_PROCESSED',
      'REVERSAL_INSUFFICIENT_FUNDS',
    ]);
  });

  test('negócio, programação e infraestrutura são hierarquias distintas', () => {
    const invalidPayload = new InvalidWagerTransactionError('x');
    expect(invalidPayload).toBeInstanceOf(DomainError);
    expect(invalidPayload).not.toBeInstanceOf(ProgrammingError);
    expect(new InvalidTransactionStateError('x')).toBeInstanceOf(ProgrammingError);

    const transient = new TransientInfrastructureError('x', { cause: new Error('lock timeout') });
    const permanent = new PermanentInfrastructureError('x');
    expect(transient).toBeInstanceOf(InfrastructureError);
    expect(transient).not.toBeInstanceOf(DomainError);
    expect(transient.retryable).toBe(true);
    expect(transient.cause).toBeInstanceOf(Error);
    expect(permanent.retryable).toBe(false);
    expect(permanent.name).toBe('PermanentInfrastructureError');
  });
});
