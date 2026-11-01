import { describe, expect, test } from 'bun:test';
import { outboxRecordOf } from '../../src/app/messaging/application/integration-event-outbox';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../src/app/wagering/domain/events/wager-transaction-events';
import { FailureCode } from '../../src/app/wagering/domain/failure-code';
import { WagerTransaction, WagerTransactionKind as Kind } from '../../src/app/wagering/domain/wager-transaction.entity';
import { WalletBalanceChanged } from '../../src/app/wallet/domain/events/wallet-balance-changed';
import { LedgerDirection } from '../../src/app/wallet/domain/ledger-entry.entity';
import { brl, newTx, openWallet, T1, T2, WALLET_ID } from '../support/wagering-fixtures';

const context = { eventId: 'event-1', correlationId: 'corr-1', occurredAt: T1 };

describe('envelope', () => {
  test('toJSON carries the README envelope, with an ISO date and no causationId when absent', () => {
    const bet = newTx(Kind.Bet);
    bet.recordObservedBalance(brl('75.00'));
    bet.markProcessed(undefined, T1);
    const json = WagerTransactionProcessed.from(bet, context).toJSON();
    expect(json).toMatchObject({
      eventId: 'event-1',
      eventType: 'WagerTransactionProcessed',
      aggregateId: bet.id,
      correlationId: 'corr-1',
      occurredAt: T1.toISOString(),
      version: 1,
    });
    expect('causationId' in json).toBe(false);
  });

  test('causationId is included when provided', () => {
    const bet = newTx(Kind.Bet);
    bet.markPendingReference();
    bet.scheduleReferenceRetry(T2);
    expect(WagerTransactionPendingReference.from(bet, { ...context, causationId: 'msg-1' }).toJSON().causationId).toBe('msg-1');
  });

  test('the outbox record uses the eventId as its id and is born ready to publish', () => {
    const wallet = openWallet();
    const entry = wallet.debit({ entryId: 'e', transactionId: 't', money: brl('25.00'), at: T1 });
    const event = WalletBalanceChanged.from(entry, context);
    expect(outboxRecordOf(event)).toEqual({
      id: 'event-1',
      aggregateId: WALLET_ID,
      eventType: 'WalletBalanceChanged',
      payload: event.toJSON() as unknown as Record<string, unknown>,
      occurredAt: T1,
      nextAttemptAt: T1,
    });
  });
});

describe('events', () => {
  test('WalletBalanceChanged carries the direction, the amounts as strings and the version', () => {
    const wallet = openWallet();
    const entry = wallet.debit({ entryId: 'e', transactionId: 't', money: brl('25.00'), at: T1 });
    expect(WalletBalanceChanged.from(entry, context).data).toEqual({
      walletId: WALLET_ID,
      transactionId: 't',
      direction: LedgerDirection.Debit,
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });

  test('WagerTransactionRejected carries the failureCode and the observed balance', () => {
    const bet = newTx(Kind.Bet);
    bet.recordObservedBalance(brl('10.00'));
    bet.reject(FailureCode.InsufficientFunds, T1);
    expect(WagerTransactionRejected.from(bet, context).data).toMatchObject({
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '10.00', currency: 'BRL' },
    });
  });

  test('WagerTransactionProcessed accepts OPENING, for the wallet opening', () => {
    const opening = WagerTransaction.createOpening({
      id: 'o',
      payloadHash: 'h',
      walletId: WALLET_ID,
      playerId: 'p',
      money: brl('100.00'),
      createdAt: T1,
    });
    opening.recordObservedBalance(brl('100.00'));
    opening.markProcessed(undefined, T1);
    expect(WagerTransactionProcessed.from(opening, context).data.kind).toBe(Kind.Opening);
  });

  test('the pending event reports the next attempt', () => {
    const refund = newTx(Kind.Refund, { referenceExternalTransactionId: 'ext-missing' });
    refund.markPendingReference();
    refund.scheduleReferenceRetry(T2);
    expect(WagerTransactionPendingReference.from(refund, context).data).toMatchObject({
      nextAttemptAt: T2.toISOString(),
      referenceExternalTransactionId: 'ext-missing',
    });
  });
});
