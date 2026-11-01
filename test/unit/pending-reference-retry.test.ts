import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../src/app/wagering/domain/failure-code';
import { ReferenceRetryPolicy } from '../../src/app/wagering/domain/reference-retry-policy';
import { WagerProcessor } from '../../src/app/wagering/domain/wager-processor';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/app/wagering/domain/wager-transaction.entity';
import { InvalidTransactionStateError } from '../../src/app/wagering/domain/wagering-errors';
import { newTx, openWallet, processedTx, T0, T1, T2 } from '../support/wagering-fixtures';

const REF = 'ext-ref';
const processor = new WagerProcessor();

const pendingRefund = (nextAttemptAt = T1): WagerTransaction => {
  const refund = newTx(Kind.Refund, { referenceExternalTransactionId: REF });
  refund.markPendingReference();
  refund.scheduleReferenceRetry(nextAttemptAt);
  return refund;
};

describe('ReferenceRetryPolicy', () => {
  const policy = ReferenceRetryPolicy.from({ baseDelayMs: 1000, maxDelayMs: 8000, maxAttempts: 5 });

  test('the delay doubles with each attempt already made', () => {
    const delays = [0, 1, 2, 3].map((made) => policy.nextAttemptAt(made, T0).getTime() - T0.getTime());
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
  });

  test('the delay never exceeds the cap, even for very large attempt counts', () => {
    expect(policy.nextAttemptAt(4, T0).getTime() - T0.getTime()).toBe(8000);
    expect(policy.nextAttemptAt(50, T0).getTime() - T0.getTime()).toBe(8000);
    expect(policy.nextAttemptAt(5000, T0).getTime() - T0.getTime()).toBe(8000);
  });

  test('the attempt limit is reached exactly at maxAttempts', () => {
    expect([0, 1, 4, 5, 6].map((made) => policy.isExhausted(made))).toEqual([false, false, false, true, true]);
  });

  test('the default policy is 5s doubling up to 5min over 10 attempts', () => {
    const delays = Array.from({ length: 9 }, (_, made) => ReferenceRetryPolicy.DEFAULT.nextAttemptAt(made, T0).getTime() - T0.getTime());
    expect(delays).toEqual([5000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
    expect(ReferenceRetryPolicy.DEFAULT.isExhausted(9)).toBe(false);
    expect(ReferenceRetryPolicy.DEFAULT.isExhausted(10)).toBe(true);
  });

  test.each([
    [{ baseDelayMs: 0, maxDelayMs: 10, maxAttempts: 1 }],
    [{ baseDelayMs: -1, maxDelayMs: 10, maxAttempts: 1 }],
    [{ baseDelayMs: 100, maxDelayMs: 99, maxAttempts: 1 }],
    [{ baseDelayMs: 100, maxDelayMs: 1000, maxAttempts: 0 }],
  ])('rejects an invalid policy %j', (props) => {
    expect(() => ReferenceRetryPolicy.from(props)).toThrow('invalid reference retry policy');
  });
});

describe('WagerTransaction: reference retry bookkeeping', () => {
  test('the first scheduling is not an attempt, and each later one is', () => {
    const refund = pendingRefund(T1);
    expect(refund.attempts).toBe(0);
    refund.scheduleReferenceRetry(T2);
    expect(refund.attempts).toBe(1);
    expect(refund.nextAttemptAt).toEqual(T2);
  });

  test('is due only when pending, scheduled, and the time has come', () => {
    const refund = pendingRefund(T1);
    expect(refund.isReferenceRetryDue(T0)).toBe(false);
    expect(refund.isReferenceRetryDue(T1)).toBe(true);
    expect(refund.isReferenceRetryDue(T2)).toBe(true);
    expect(newTx(Kind.Bet).isReferenceRetryDue(T2)).toBe(false);
  });

  test('expiring counts the last attempt and ends in REJECTED with the given code', () => {
    const refund = pendingRefund(T1);
    refund.scheduleReferenceRetry(T2);
    refund.expireReference(FailureCode.ReferenceNotFound, T2);
    expect(refund.status).toBe(Status.Rejected);
    expect(refund.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(refund.attempts).toBe(2);
    expect(refund.processedAt).toEqual(T2);
    expect(refund.nextAttemptAt).toBeUndefined();
    expect(refund.isReferenceRetryDue(T2)).toBe(false);
  });

  test('only a pending transaction can expire, and a terminal one never changes', () => {
    expect(() => newTx(Kind.Refund, { referenceExternalTransactionId: REF }).expireReference(FailureCode.ReferenceNotFound, T1)).toThrow(
      InvalidTransactionStateError,
    );
    const done = pendingRefund();
    done.expireReference(FailureCode.ReferenceNotFound, T1);
    expect(() => done.expireReference(FailureCode.ReferenceNotFound, T2)).toThrow(InvalidTransactionStateError);
    expect(() => done.scheduleReferenceRetry(T2)).toThrow(InvalidTransactionStateError);
    expect(done.attempts).toBe(1);
  });

  test('a failure code that is not a rejection code cannot expire a reference', () => {
    expect(() => pendingRefund().expireReference(FailureCode.InternalError, T1)).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerProcessor: resuming a pending reversal', () => {
  const resume = (refund: WagerTransaction, reference?: WagerTransaction) =>
    processor.process({ wallet: openWallet('100.00'), transaction: refund, reference, ledgerEntryId: 'entry-1', at: T2 });

  test('a missing reference keeps the transaction pending with no financial effect', () => {
    const wallet = openWallet('100.00');
    const refund = pendingRefund();
    const result = processor.process({ wallet, transaction: refund, ledgerEntryId: 'entry-1', at: T2 });
    expect(result.outcome).toBe('PENDING_REFERENCE');
    expect(refund.status).toBe(Status.PendingReference);
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
  });

  test('a reference that is itself still pending keeps the reversal pending', () => {
    const bet = newTx(Kind.Bet, { externalTransactionId: REF });
    bet.markPendingReference();
    expect(resume(pendingRefund(), bet).outcome).toBe('PENDING_REFERENCE');
  });

  test('a reference that arrived processed settles the reversal exactly once', () => {
    const wallet = openWallet('100.00');
    const bet = processedTx(Kind.Bet, { externalTransactionId: REF });
    const refund = pendingRefund();
    const result = processor.process({ wallet, transaction: refund, reference: bet, ledgerEntryId: 'entry-1', at: T2 });
    expect(result.outcome).toBe('APPLIED');
    expect(refund.status).toBe(Status.Processed);
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.toJSON().amount).toBe('125.00');
    expect(wallet.version).toBe(2);
  });

  test('a reference that arrived invalid rejects the reversal with its specific code and no effect', () => {
    const wallet = openWallet('100.00');
    const wrongRound = processedTx(Kind.Bet, { externalTransactionId: REF, roundId: 'another-round' });
    const refund = pendingRefund();
    const result = processor.process({ wallet, transaction: refund, reference: wrongRound, ledgerEntryId: 'entry-1', at: T2 });
    expect(result).toMatchObject({ outcome: 'REJECTED', failureCode: FailureCode.ReferenceMismatch });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
  });

  test('a reference that ended rejected rejects the reversal as not processed', () => {
    const rejectedBet = newTx(Kind.Bet, { externalTransactionId: REF });
    rejectedBet.reject(FailureCode.InsufficientFunds, T1);
    expect(resume(pendingRefund(), rejectedBet)).toMatchObject({ outcome: 'REJECTED', failureCode: FailureCode.ReferenceNotProcessed });
  });

  test('expiring with no reference at all is REFERENCE_NOT_FOUND and leaves the wallet intact', () => {
    const wallet = openWallet('100.00');
    const refund = pendingRefund();
    const result = processor.expireReference(wallet, refund, undefined, T2);
    expect(result).toMatchObject({ outcome: 'REJECTED', failureCode: FailureCode.ReferenceNotFound });
    expect(refund.status).toBe(Status.Rejected);
    expect(refund.observedBalance?.equals(wallet.balance)).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test('expiring while the reference exists but never settled is REFERENCE_NOT_PROCESSED', () => {
    const wallet = openWallet('100.00');
    const stuck = newTx(Kind.Bet, { externalTransactionId: REF });
    stuck.markPendingReference();
    const refund = pendingRefund();
    expect(processor.expireReference(wallet, refund, stuck, T2)).toMatchObject({
      outcome: 'REJECTED',
      failureCode: FailureCode.ReferenceNotProcessed,
    });
  });
});
