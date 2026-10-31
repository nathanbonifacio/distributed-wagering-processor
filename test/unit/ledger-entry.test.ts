import { describe, expect, test } from 'bun:test';
import { type CreateLedgerEntryProps, LedgerDirection, WalletLedgerEntry } from '../../src/wallet/domain/ledger-entry';
import { InvalidLedgerEntryError } from '../../src/wallet/domain/wallet-errors';
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
  test('CREDIT: depois = antes + valor', () => {
    const entry = WalletLedgerEntry.create(props());
    expect(entry.isBalanced()).toBe(true);
    expect(entry.id).toBe('entry-1');
    expect(entry.walletVersion).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.createdAt).toEqual(T0);
  });

  test('DEBIT: depois = antes - valor', () => {
    expect(WalletLedgerEntry.create(debitProps()).isBalanced()).toBe(true);
  });

  test('o débito pode levar o saldo a zero', () => {
    expect(WalletLedgerEntry.create(debitProps({ money: brl('100.00'), balanceAfter: brl('0.00') })).isBalanced()).toBe(true);
  });

  const invalid: Array<[string, Partial<CreateLedgerEntryProps>]> = [
    ['CREDIT com aritmética errada', { balanceAfter: brl('125.01') }],
    ['CREDIT calculado como débito', { balanceAfter: brl('75.00') }],
    ['DEBIT com aritmética errada', { direction: LedgerDirection.Debit, balanceAfter: brl('75.01') }],
    ['DEBIT calculado como crédito', { direction: LedgerDirection.Debit }],
    ['valor zero', { money: brl('0.00'), balanceAfter: brl('100.00') }],
    ['valor negativo', { money: brl('25.00').negate(), balanceAfter: brl('75.00') }],
    ['saldo posterior negativo', { direction: LedgerDirection.Debit, balanceAfter: brl('75.00').negate(), money: brl('175.00') }],
    ['saldo anterior negativo', { balanceBefore: brl('5.00').negate(), balanceAfter: brl('20.00') }],
    ['moeda do valor difere', { money: usd('25.00') }],
    ['moeda do saldo anterior difere', { balanceBefore: usd('100.00') }],
    ['moeda do saldo posterior difere', { balanceAfter: usd('125.00') }],
    ['sem id', { id: '' }],
    ['sem walletId', { walletId: '' }],
    ['sem transactionId', { transactionId: '' }],
    ['versão zero', { walletVersion: 0 }],
    ['versão fracionária', { walletVersion: 1.5 }],
  ];
  test.each(invalid)('rejeita: %s', (_label, overrides) => {
    expect(() => WalletLedgerEntry.create(props(overrides))).toThrow(InvalidLedgerEntryError);
  });
});

describe('imutabilidade', () => {
  test('a instância está congelada', () => {
    const entry = WalletLedgerEntry.create(props());
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => { (entry as unknown as { direction: string }).direction = 'DEBIT'; }).toThrow(TypeError);
    expect(() => { (entry as unknown as Record<string, unknown>).extra = 1; }).toThrow(TypeError);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test('não há métodos de edição ou transição', () => {
    const methods = Object.getOwnPropertyNames(WalletLedgerEntry.prototype).filter((name) => name !== 'constructor');
    expect(methods.sort()).toEqual(['createdAt', 'isBalanced']);
  });

  test('alterar os Date recebido e exposto não afeta o lançamento', () => {
    const at = new Date(T0);
    const entry = WalletLedgerEntry.create(props({ createdAt: at }));
    at.setFullYear(2000);
    entry.createdAt.setFullYear(2000);
    expect(entry.createdAt).toEqual(T0);
  });
});

describe('rehydrate', () => {
  test('reconstrói sem revalidar; isBalanced permite auditar', () => {
    const entry = WalletLedgerEntry.rehydrate(props({ balanceAfter: brl('999.00') }));
    expect(entry.balanceAfter.equals(brl('999.00'))).toBe(true);
    expect(entry.isBalanced()).toBe(false);
    expect(Object.isFrozen(entry)).toBe(true);
  });
});
