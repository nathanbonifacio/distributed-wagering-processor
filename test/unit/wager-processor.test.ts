import { describe, expect, test } from 'bun:test';
import { LedgerDirection } from '../../src/app/wallet/domain/ledger-entry.entity';
import { Wallet } from '../../src/app/wallet/domain/wallet.entity';
import { FailureCode } from '../../src/app/wagering/domain/failure-code';
import { type ProcessWagerInput, WagerProcessor } from '../../src/app/wagering/domain/wager-processor';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/app/wagering/domain/wager-transaction.entity';
import { InvalidWagerOperationError } from '../../src/app/wagering/domain/wagering-errors';
import { brl, newTx, openWallet, processedTx, PLAYER_ID, T0, T1, T2, usd, WALLET_ID } from '../support/wagering-fixtures';

const processor = new WagerProcessor();
const REF = 'ext-ref';

const run = (input: Omit<ProcessWagerInput, 'ledgerEntryId' | 'at'>) =>
  processor.process({ ledgerEntryId: 'entry-1', at: T1, ...input });

const reversal = (kind: Kind, overrides = {}) => newTx(kind, { referenceExternalTransactionId: REF, ...overrides });
const processedRef = (kind: Kind, overrides = {}) => processedTx(kind, { externalTransactionId: REF, ...overrides });

/** Rejeição: terminal, com código, saldo observado, e a wallet intacta. */
function expectRejected(wallet: Wallet, transaction: WagerTransaction, result: ReturnType<typeof run>, code: FailureCode) {
  expect(wallet.version).toBe(1);
  expect(wallet.updatedAt).toEqual(T0);
  expect(result.outcome).toBe('REJECTED');
  if (result.outcome !== 'REJECTED') return;
  expect(result.failureCode).toBe(code);
  expect('ledgerEntry' in result).toBe(false);
  expect(transaction.status).toBe(Status.Rejected);
  expect(transaction.failureCode).toBe(code);
  expect(transaction.processedAt).toEqual(T1);
  expect(transaction.referenceTransactionId).toBeUndefined();
  expect(transaction.observedBalance?.equals(wallet.balance)).toBe(true);
  expect(result.balance.equals(wallet.balance)).toBe(true);
}

/** Aplicada: terminal, um lançamento coerente com a wallet, e saldo observado igual ao final. */
function expectApplied(
  wallet: Wallet,
  transaction: WagerTransaction,
  result: ReturnType<typeof run>,
  direction: LedgerDirection,
  balance: string,
) {
  expect(result.outcome).toBe('APPLIED');
  if (result.outcome !== 'APPLIED') return;
  expect(result.ledgerEntry?.direction).toBe(direction);
  expect(result.ledgerEntry?.id).toBe('entry-1');
  expect(result.ledgerEntry?.transactionId).toBe(transaction.id);
  expect(result.ledgerEntry?.money.equals(transaction.money)).toBe(true);
  expect(result.ledgerEntry?.walletVersion).toBe(wallet.version);
  expect(result.ledgerEntry?.balanceAfter.equals(wallet.balance)).toBe(true);
  expect(result.ledgerEntry?.isBalanced()).toBe(true);
  expect(wallet.balance.equals(brl(balance))).toBe(true);
  expect(result.balance.equals(brl(balance))).toBe(true);
  expect(transaction.status).toBe(Status.Processed);
  expect(transaction.processedAt).toEqual(T1);
  expect(transaction.observedBalance?.equals(brl(balance))).toBe(true);
}

describe('BET', () => {
  test('debits and produces a DEBIT', () => {
    const wallet = openWallet('100.00');
    const transaction = newTx(Kind.Bet, { money: brl('80.00') });
    const result = run({ wallet, transaction });
    expectApplied(wallet, transaction, result, LedgerDirection.Debit, '20.00');
    expect(wallet.version).toBe(2);
  });

  test('can consume the whole balance', () => {
    const wallet = openWallet('25.00');
    const transaction = newTx(Kind.Bet);
    expectApplied(wallet, transaction, run({ wallet, transaction }), LedgerDirection.Debit, '0.00');
  });

  test('insufficient funds: INSUFFICIENT_FUNDS, without changing the wallet', () => {
    const wallet = openWallet('20.00');
    const transaction = newTx(Kind.Bet, { money: brl('80.00') });
    expectRejected(wallet, transaction, run({ wallet, transaction }), FailureCode.InsufficientFunds);
    expect(wallet.balance.equals(brl('20.00'))).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test('section 8 scenario, in sequence: 100 / 80 / 80', () => {
    const wallet = openWallet('100.00');
    const first = newTx(Kind.Bet, { externalTransactionId: 'bet-1', money: brl('80.00') });
    const second = newTx(Kind.Bet, { externalTransactionId: 'bet-2', money: brl('80.00') });
    expect(run({ wallet, transaction: first }).outcome).toBe('APPLIED');
    expect(run({ wallet, transaction: second }).outcome).toBe('REJECTED');
    expect(second.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(second.observedBalance?.equals(brl('20.00'))).toBe(true);
    expect(wallet.balance.equals(brl('20.00'))).toBe(true);
    expect(wallet.version).toBe(2);
  });
});

describe('WIN', () => {
  test('without a reference: credits and produces a CREDIT', () => {
    const wallet = openWallet('100.00');
    const transaction = newTx(Kind.Win);
    expectApplied(wallet, transaction, run({ wallet, transaction }), LedgerDirection.Credit, '125.00');
    expect(transaction.referenceTransactionId).toBeUndefined();
  });

  test('with a reference to a BET of the same round, free amount', () => {
    const wallet = openWallet('100.00');
    const reference = processedRef(Kind.Bet);
    const transaction = reversal(Kind.Win, { money: brl('500.00') });
    expectApplied(wallet, transaction, run({ wallet, transaction, reference }), LedgerDirection.Credit, '600.00');
    expect(transaction.referenceTransactionId).toBe(reference.id);
  });

  test('missing reference: stays pending, even though it is optional when not given', () => {
    const wallet = openWallet('100.00');
    const transaction = reversal(Kind.Win);
    expect(run({ wallet, transaction }).outcome).toBe('PENDING_REFERENCE');
  });

  test('a reference to a WIN is invalid', () => {
    const wallet = openWallet('100.00');
    const transaction = reversal(Kind.Win);
    const result = run({ wallet, transaction, reference: processedRef(Kind.Win) });
    expectRejected(wallet, transaction, result, FailureCode.ReferenceKindInvalid);
  });

  test('credit past the limit: BALANCE_LIMIT_EXCEEDED, without changing the wallet', () => {
    const wallet = openWallet('999999999999999999.99');
    const transaction = newTx(Kind.Win, { money: brl('0.01') });
    expectRejected(wallet, transaction, run({ wallet, transaction }), FailureCode.BalanceLimitExceeded);
    expect(wallet.version).toBe(1);
  });
});

describe('LOSS', () => {
  test('records without moving balance, without a ledger entry and without bumping the version', () => {
    const wallet = openWallet('100.00');
    const transaction = newTx(Kind.Loss);
    const result = run({ wallet, transaction });
    expect(result.outcome).toBe('APPLIED');
    if (result.outcome !== 'APPLIED') return;
    expect(result.ledgerEntry).toBeUndefined();
    expect(result.balance.equals(brl('100.00'))).toBe(true);
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(T0);
    expect(transaction.status).toBe(Status.Processed);
    expect(transaction.observedBalance?.equals(brl('100.00'))).toBe(true);
  });

  test('an amount larger than the balance is not a problem: nothing is debited', () => {
    const wallet = openWallet('1.00');
    const transaction = newTx(Kind.Loss, { money: brl('500.00') });
    expect(run({ wallet, transaction }).outcome).toBe('APPLIED');
    expect(wallet.balance.equals(brl('1.00'))).toBe(true);
  });

  test('with a reference to a BET, keeps the internal id', () => {
    const wallet = openWallet('100.00');
    const reference = processedRef(Kind.Bet);
    const transaction = reversal(Kind.Loss);
    run({ wallet, transaction, reference });
    expect(transaction.referenceTransactionId).toBe(reference.id);
    expect(wallet.version).toBe(1);
  });
});

describe('REFUND', () => {
  test('credits the full amount of the BET', () => {
    const wallet = openWallet('75.00');
    const reference = processedRef(Kind.Bet);
    const transaction = reversal(Kind.Refund);
    expectApplied(wallet, transaction, run({ wallet, transaction, reference }), LedgerDirection.Credit, '100.00');
    expect(transaction.referenceTransactionId).toBe(reference.id);
  });

  test('no partial reversal: AMOUNT_MISMATCH', () => {
    const wallet = openWallet('75.00');
    const transaction = reversal(Kind.Refund, { money: brl('10.00') });
    const result = run({ wallet, transaction, reference: processedRef(Kind.Bet) });
    expectRejected(wallet, transaction, result, FailureCode.AmountMismatch);
    expect(wallet.version).toBe(1);
  });

  test.each([Kind.Win, Kind.Loss])('reference to %s: REFERENCE_KIND_INVALID', (kind) => {
    const wallet = openWallet('75.00');
    const transaction = reversal(Kind.Refund);
    const result = run({ wallet, transaction, reference: processedRef(kind) });
    expectRejected(wallet, transaction, result, FailureCode.ReferenceKindInvalid);
  });
});

describe('ROLLBACK', () => {
  test('of a BET: credits', () => {
    const wallet = openWallet('75.00');
    const transaction = reversal(Kind.Rollback);
    const result = run({ wallet, transaction, reference: processedRef(Kind.Bet) });
    expectApplied(wallet, transaction, result, LedgerDirection.Credit, '100.00');
  });

  test('of a WIN: debits', () => {
    const wallet = openWallet('125.00');
    const transaction = reversal(Kind.Rollback);
    const result = run({ wallet, transaction, reference: processedRef(Kind.Win) });
    expectApplied(wallet, transaction, result, LedgerDirection.Debit, '100.00');
  });

  test('of a REFUND: debits', () => {
    const wallet = openWallet('100.00');
    const reference = processedTx(Kind.Refund, { externalTransactionId: REF, referenceExternalTransactionId: 'ext-bet' });
    const transaction = reversal(Kind.Rollback);
    expectApplied(wallet, transaction, run({ wallet, transaction, reference }), LedgerDirection.Debit, '75.00');
  });

  test('of a WIN without funds: REVERSAL_INSUFFICIENT_FUNDS, distinct from a bet without funds', () => {
    const wallet = openWallet('10.00');
    const transaction = reversal(Kind.Rollback);
    const result = run({ wallet, transaction, reference: processedRef(Kind.Win) });
    expectRejected(wallet, transaction, result, FailureCode.ReversalInsufficientFunds);
    expect(wallet.balance.equals(brl('10.00'))).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test('of a LOSS: REFERENCE_KIND_INVALID', () => {
    const wallet = openWallet();
    const transaction = reversal(Kind.Rollback);
    const result = run({ wallet, transaction, reference: processedRef(Kind.Loss) });
    expectRejected(wallet, transaction, result, FailureCode.ReferenceKindInvalid);
  });

  test('of an OPENING: REFERENCE_KIND_INVALID', () => {
    const wallet = openWallet();
    const reference = WagerTransaction.rehydrate({
      id: 'tx-open',
      providerId: 'provider-a',
      externalTransactionId: REF,
      idempotencyKey: 'k',
      payloadHash: 'h',
      walletId: WALLET_ID,
      playerId: PLAYER_ID,
      roundId: 'round-1',
      gameId: 'g',
      kind: Kind.Opening,
      money: brl('25.00'),
      createdAt: T0,
      status: Status.Processed,
      processedAt: T0,
    });
    const transaction = reversal(Kind.Rollback);
    const result = run({ wallet, transaction, reference });
    expectRejected(wallet, transaction, result, FailureCode.ReferenceKindInvalid);
  });

  test('of a ROLLBACK: REFERENCE_KIND_INVALID', () => {
    const wallet = openWallet();
    const reference = processedTx(Kind.Rollback, { externalTransactionId: REF, referenceExternalTransactionId: 'ext-bet' });
    const transaction = reversal(Kind.Rollback);
    const result = run({ wallet, transaction, reference });
    expectRejected(wallet, transaction, result, FailureCode.ReferenceKindInvalid);
  });
});

describe.each([Kind.Refund, Kind.Rollback])('mismatched references in %s', (kind) => {
  test.each([
    ['provider', { providerId: 'provider-b' }],
    ['player', { playerId: 'player-2' }],
    ['wallet', { walletId: 'wallet-2' }],
    ['currency', { money: usd('25.00') }],
    ['round', { roundId: 'round-2' }],
  ])('different %s: REFERENCE_MISMATCH', (_label, overrides) => {
    const wallet = openWallet();
    const transaction = reversal(kind);
    const result = run({ wallet, transaction, reference: processedRef(Kind.Bet, overrides) });
    expectRejected(wallet, transaction, result, FailureCode.ReferenceMismatch);
    expect(wallet.version).toBe(1);
  });

  test('REJECTED reference: REFERENCE_NOT_PROCESSED', () => {
    const wallet = openWallet();
    const reference = newTx(Kind.Bet, { externalTransactionId: REF });
    reference.reject(FailureCode.InsufficientFunds, T0);
    const transaction = reversal(kind);
    expectRejected(wallet, transaction, run({ wallet, transaction, reference }), FailureCode.ReferenceNotProcessed);
  });

  test('FAILED reference: REFERENCE_NOT_PROCESSED', () => {
    const wallet = openWallet();
    const reference = newTx(Kind.Bet, { externalTransactionId: REF });
    reference.fail(FailureCode.InternalError, T0);
    const transaction = reversal(kind);
    expectRejected(wallet, transaction, run({ wallet, transaction, reference }), FailureCode.ReferenceNotProcessed);
  });

  test('divergent amount: AMOUNT_MISMATCH', () => {
    const wallet = openWallet();
    const transaction = reversal(kind, { money: brl('25.01') });
    const result = run({ wallet, transaction, reference: processedRef(Kind.Bet) });
    expectRejected(wallet, transaction, result, FailureCode.AmountMismatch);
  });
});

describe('exclusivity of reversals', () => {
  const earlier = (kind: Kind) =>
    processedTx(kind, { externalTransactionId: 'ext-earlier', referenceExternalTransactionId: REF });

  test.each([
    [Kind.Refund, Kind.Refund],
    [Kind.Refund, Kind.Rollback],
    [Kind.Rollback, Kind.Refund],
    [Kind.Rollback, Kind.Rollback],
  ])('%s after %s: ALREADY_REVERSED, without credit', (kind, previous) => {
    const wallet = openWallet('75.00');
    const transaction = reversal(kind);
    const result = run({ wallet, transaction, reference: processedRef(Kind.Bet), existingReversal: earlier(previous) });
    expectRejected(wallet, transaction, result, FailureCode.AlreadyReversed);
    expect(wallet.balance.equals(brl('75.00'))).toBe(true);
  });

  test('a BET refunded by a REFUND that was rolled back is not refunded again', () => {
    const wallet = openWallet('75.00');
    const transaction = reversal(Kind.Refund);
    const result = run({ wallet, transaction, reference: processedRef(Kind.Bet), existingReversal: earlier(Kind.Refund) });
    expect(result.outcome).toBe('REJECTED');
    expect(transaction.failureCode).toBe(FailureCode.AlreadyReversed);
  });

  test('a WIN is not a reversal: several can reference the same BET', () => {
    const wallet = openWallet('75.00');
    const transaction = reversal(Kind.Win);
    const result = run({ wallet, transaction, reference: processedRef(Kind.Bet), existingReversal: earlier(Kind.Refund) });
    expect(result.outcome).toBe('APPLIED');
  });
});

describe('out-of-order references', () => {
  test.each([Kind.Refund, Kind.Rollback])('%s without a reference stays PENDING_REFERENCE, with no observed balance', (kind) => {
    const wallet = openWallet();
    const transaction = reversal(kind);
    const result = run({ wallet, transaction });
    expect(result.outcome).toBe('PENDING_REFERENCE');
    expect('balance' in result).toBe(false);
    expect(transaction.status).toBe(Status.PendingReference);
    expect(transaction.observedBalance).toBeUndefined();
    expect(transaction.processedAt).toBeUndefined();
    expect(wallet.version).toBe(1);
  });

  test('an existing reference that is not yet decided also waits', () => {
    const wallet = openWallet();
    const transaction = reversal(Kind.Refund);
    const result = run({ wallet, transaction, reference: newTx(Kind.Bet, { externalTransactionId: REF }) });
    expect(result.outcome).toBe('PENDING_REFERENCE');
  });

  test('an undecided but mismatched reference is rejected at once', () => {
    const wallet = openWallet();
    const transaction = reversal(Kind.Refund);
    const reference = newTx(Kind.Bet, { externalTransactionId: REF, roundId: 'round-2' });
    expectRejected(wallet, transaction, run({ wallet, transaction, reference }), FailureCode.ReferenceMismatch);
  });

  test('resumption: stays pending while the reference has not arrived, then is applied', () => {
    const wallet = openWallet('75.00');
    const transaction = reversal(Kind.Refund);
    run({ wallet, transaction });
    expect(run({ wallet, transaction }).outcome).toBe('PENDING_REFERENCE');
    expect(transaction.status).toBe(Status.PendingReference);

    const result = processor.process({ wallet, transaction, reference: processedRef(Kind.Bet), ledgerEntryId: 'entry-1', at: T2 });
    expect(result.outcome).toBe('APPLIED');
    expect(transaction.status).toBe(Status.Processed);
    expect(transaction.processedAt).toEqual(T2);
    expect(wallet.balance.equals(brl('100.00'))).toBe(true);
  });

  test('resumption: the reference arrived rejected', () => {
    const wallet = openWallet();
    const transaction = reversal(Kind.Refund);
    run({ wallet, transaction });
    const reference = newTx(Kind.Bet, { externalTransactionId: REF });
    reference.reject(FailureCode.InsufficientFunds, T0);
    expectRejected(wallet, transaction, run({ wallet, transaction, reference }), FailureCode.ReferenceNotProcessed);
  });

  test('rehydrated as PENDING_REFERENCE is resumed normally', () => {
    const wallet = openWallet('75.00');
    const pending = reversal(Kind.Refund);
    run({ wallet, transaction: pending });
    const transaction = WagerTransaction.rehydrate({
      id: pending.id,
      providerId: pending.providerId,
      externalTransactionId: pending.externalTransactionId,
      idempotencyKey: pending.idempotencyKey,
      payloadHash: pending.payloadHash,
      walletId: pending.walletId,
      playerId: pending.playerId,
      roundId: pending.roundId,
      gameId: pending.gameId,
      kind: pending.kind,
      money: pending.money,
      referenceExternalTransactionId: pending.referenceExternalTransactionId,
      createdAt: pending.createdAt,
      status: pending.status,
    });
    expect(run({ wallet, transaction, reference: processedRef(Kind.Bet) }).outcome).toBe('APPLIED');
  });
});

describe('validation against the wallet', () => {
  test('different player: PLAYER_WALLET_MISMATCH', () => {
    const wallet = openWallet();
    const transaction = newTx(Kind.Bet, { playerId: 'player-2' });
    expectRejected(wallet, transaction, run({ wallet, transaction }), FailureCode.PlayerWalletMismatch);
    expect(wallet.version).toBe(1);
  });

  test('different currency: CURRENCY_MISMATCH, on debit and on credit', () => {
    for (const kind of [Kind.Bet, Kind.Win]) {
      const wallet = openWallet();
      const transaction = newTx(kind, { money: usd('25.00') });
      expectRejected(wallet, transaction, run({ wallet, transaction }), FailureCode.CurrencyMismatch);
      expect(wallet.version).toBe(1);
    }
  });

  test('wallet validation comes before waiting for the reference', () => {
    const wallet = openWallet();
    const transaction = reversal(Kind.Refund, { playerId: 'player-2' });
    expectRejected(wallet, transaction, run({ wallet, transaction }), FailureCode.PlayerWalletMismatch);
  });
});

describe('processor contracts (programming errors)', () => {
  test('a terminal transaction is not reprocessed and produces no second entry', () => {
    const wallet = openWallet();
    const transaction = newTx(Kind.Bet);
    run({ wallet, transaction });
    const version = wallet.version;
    expect(() => run({ wallet, transaction })).toThrow(InvalidWagerOperationError);
    expect(wallet.version).toBe(version);
  });

  test('wallet from another transaction', () => {
    const wallet = openWallet();
    expect(() => run({ wallet, transaction: newTx(Kind.Bet, { walletId: 'wallet-2' }) })).toThrow(InvalidWagerOperationError);
  });

  test('OPENING does not go through process', () => {
    const wallet = openWallet();
    const transaction = WagerTransaction.createOpening({
      id: 't',
      payloadHash: 'h',
      walletId: WALLET_ID,
      playerId: PLAYER_ID,
      money: brl('100.00'),
      createdAt: T0,
    });
    expect(() => run({ wallet, transaction })).toThrow(InvalidWagerOperationError);
  });

  test('a reference that is not the requested one, or given to one that did not request it', () => {
    const wallet = openWallet();
    const other = processedTx(Kind.Bet, { externalTransactionId: 'ext-other' });
    expect(() => run({ wallet, transaction: reversal(Kind.Refund), reference: other })).toThrow(InvalidWagerOperationError);
    expect(() => run({ wallet, transaction: newTx(Kind.Win), reference: other })).toThrow(InvalidWagerOperationError);
    expect(wallet.version).toBe(1);
  });
});

describe('opening', () => {
  const opening = (amount = '1000.00', walletId = WALLET_ID) =>
    WagerTransaction.createOpening({
      id: 'tx-open',
      payloadHash: 'hash-open',
      walletId,
      playerId: PLAYER_ID,
      money: brl(amount),
      createdAt: T0,
    });
  const input = (wallet: Wallet, transaction: WagerTransaction) => ({ wallet, transaction, ledgerEntryId: 'entry-0', at: T0 });

  test('processes the OPENING: CREDIT at version 1, PROCESSED, balance unchanged', () => {
    const wallet = openWallet('1000.00');
    const transaction = opening();
    const result = processor.processOpening(input(wallet, transaction));
    expect(result.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(result.ledgerEntry?.walletVersion).toBe(1);
    expect(result.ledgerEntry?.balanceAfter.equals(brl('1000.00'))).toBe(true);
    expect(result.balance.equals(brl('1000.00'))).toBe(true);
    expect(transaction.status).toBe(Status.Processed);
    expect(transaction.observedBalance?.equals(brl('1000.00'))).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test('refuses a transaction that is not an OPENING, from another wallet or with another amount', () => {
    const wallet = openWallet('1000.00');
    expect(() => processor.processOpening(input(wallet, newTx(Kind.Bet)))).toThrow(InvalidWagerOperationError);
    expect(() => processor.processOpening(input(wallet, opening('1000.00', 'wallet-2')))).toThrow(InvalidWagerOperationError);
    expect(() => processor.processOpening(input(wallet, opening('999.00')))).toThrow(InvalidWagerOperationError);
  });
});

describe('invariant: balance rebuilt from the ledger', () => {
  test('sequence of operations: the ledger explains the balance and the version', () => {
    const wallet = openWallet('100.00');
    const entries = [
      processor.processOpening({
        wallet,
        transaction: WagerTransaction.createOpening({
          id: 'tx-open',
          payloadHash: 'h',
          walletId: WALLET_ID,
          playerId: PLAYER_ID,
          money: brl('100.00'),
          createdAt: T0,
        }),
        ledgerEntryId: 'e0',
        at: T0,
      }).ledgerEntry!,
    ];

    const bet = newTx(Kind.Bet, { externalTransactionId: 'bet', money: brl('30.00') });
    const steps: Array<Omit<ProcessWagerInput, 'ledgerEntryId' | 'at'>> = [
      { wallet, transaction: bet },
      { wallet, transaction: newTx(Kind.Bet, { externalTransactionId: 'too-much', money: brl('500.00') }) },
      { wallet, transaction: newTx(Kind.Loss, { externalTransactionId: 'loss' }) },
      { wallet, transaction: newTx(Kind.Win, { externalTransactionId: 'win', money: brl('10.10') }) },
      {
        wallet,
        transaction: newTx(Kind.Refund, { externalTransactionId: 'refund', referenceExternalTransactionId: 'bet', money: brl('30.00') }),
        reference: bet,
      },
    ];
    steps.forEach((step, index) => {
      const result = processor.process({ ...step, ledgerEntryId: `e${index + 1}`, at: T1 });
      if (result.outcome === 'APPLIED' && result.ledgerEntry) entries.push(result.ledgerEntry);
    });

    expect(entries).toHaveLength(4); // abertura, BET, WIN, REFUND; a rejeição e o LOSS não geram lançamento
    expect(new Set(entries.map((e) => e.transactionId)).size).toBe(entries.length);

    const rebuilt = entries.reduce(
      (sum, e) => (e.direction === LedgerDirection.Credit ? sum.add(e.money) : sum.subtract(e.money)),
      brl('0.00'),
    );
    expect(rebuilt.equals(wallet.balance)).toBe(true);
    expect(wallet.balance.equals(brl('110.10'))).toBe(true);
    expect(wallet.version).toBe(Math.max(...entries.map((e) => e.walletVersion)));
    for (const entry of entries) expect(entry.isBalanced()).toBe(true);
  });
});
