import { describe, expect, test } from 'bun:test';
import { type CreateLedgerEntryProps, LedgerDirection, WalletLedgerEntry } from '../../src/app/wallet/domain/ledger-entry.entity';
import { InvalidLedgerEntryError } from '../../src/app/wallet/domain/wallet-errors';
import { brl, T0, usd, WALLET_ID } from '../support/wagering-fixtures';

const props = (overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps => ({
  id: 'entry-1',
  walletId: WALLET_ID,
  transactionId: 'tx-1',
  walletVersion: 2,
  direction: LedgerDirection.Credit,
  money: brl('25.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('125.00'),
  createdAt: T0,
  ...overrides,
});
const debitProps = (overrides: Partial<CreateLedgerEntryProps> = {}) =>
  props({ direction: LedgerDirection.Debit, balanceAfter: brl('75.00'), ...overrides });

describe('create', () => {
  test('CREDIT: after = before + amount', () => {
    const entry = WalletLedgerEntry.create(props());
    expect(entry.isBalanced()).toBe(true);
    expect(entry.id).toBe('entry-1');
    expect(entry.walletVersion).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.createdAt).toEqual(T0);
  });

  test('DEBIT: after = before - amount', () => {
    expect(WalletLedgerEntry.create(debitProps()).isBalanced()).toBe(true);
  });

  test('a debit can bring the balance to zero', () => {
    expect(WalletLedgerEntry.create(debitProps({ money: brl('100.00'), balanceAfter: brl('0.00') })).isBalanced()).toBe(true);
  });

  const invalid: Array<[string, Partial<CreateLedgerEntryProps>]> = [
    ['CREDIT with wrong arithmetic', { balanceAfter: brl('125.01') }],
    ['CREDIT computed as a debit', { balanceAfter: brl('75.00') }],
    ['DEBIT with wrong arithmetic', { direction: LedgerDirection.Debit, balanceAfter: brl('75.01') }],
    ['DEBIT computed as a credit', { direction: LedgerDirection.Debit }],
    ['zero amount', { money: brl('0.00'), balanceAfter: brl('100.00') }],
    ['negative amount', { money: brl('25.00').negate(), balanceAfter: brl('75.00') }],
    ['negative resulting balance', { direction: LedgerDirection.Debit, balanceAfter: brl('75.00').negate(), money: brl('175.00') }],
    ['negative previous balance', { balanceBefore: brl('5.00').negate(), balanceAfter: brl('20.00') }],
    ['amount currency differs', { money: usd('25.00') }],
    ['previous balance currency differs', { balanceBefore: usd('100.00') }],
    ['resulting balance currency differs', { balanceAfter: usd('125.00') }],
    ['missing id', { id: '' }],
    ['missing walletId', { walletId: '' }],
    ['missing transactionId', { transactionId: '' }],
    ['zero version', { walletVersion: 0 }],
    ['fractional version', { walletVersion: 1.5 }],
  ];
  test.each(invalid)('rejects: %s', (_label, overrides) => {
    expect(() => WalletLedgerEntry.create(props(overrides))).toThrow(InvalidLedgerEntryError);
  });
});

describe('immutability', () => {
  test('the instance is frozen', () => {
    const entry = WalletLedgerEntry.create(props());
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => { (entry as unknown as { direction: string }).direction = 'DEBIT'; }).toThrow(TypeError);
    expect(() => { (entry as unknown as Record<string, unknown>).extra = 1; }).toThrow(TypeError);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test('there are no edit or transition methods', () => {
    const methods = Object.getOwnPropertyNames(WalletLedgerEntry.prototype).filter((name) => name !== 'constructor');
    expect(methods.sort()).toEqual(['createdAt', 'isBalanced']);
  });

  test('changing the received and exposed Date objects does not affect the entry', () => {
    const at = new Date(T0);
    const entry = WalletLedgerEntry.create(props({ createdAt: at }));
    at.setFullYear(2000);
    entry.createdAt.setFullYear(2000);
    expect(entry.createdAt).toEqual(T0);
  });
});

describe('rehydrate', () => {
  test('rehydrates without revalidating; isBalanced allows auditing', () => {
    const entry = WalletLedgerEntry.rehydrate(props({ balanceAfter: brl('999.00') }));
    expect(entry.balanceAfter.equals(brl('999.00'))).toBe(true);
    expect(entry.isBalanced()).toBe(false);
    expect(Object.isFrozen(entry)).toBe(true);
  });
});
