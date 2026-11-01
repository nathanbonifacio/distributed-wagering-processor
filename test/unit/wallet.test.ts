import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, Money } from '../../src/shared/domain/money';
import { LedgerDirection } from '../../src/app/wallet/domain/ledger-entry.entity';
import { Wallet } from '../../src/app/wallet/domain/wallet.entity';
import { InsufficientFundsError, InvalidLedgerEntryError, InvalidWalletError } from '../../src/app/wallet/domain/wallet-errors';
import { brl, openWallet, PLAYER_ID, T0, T1, usd, WALLET_ID } from '../support/wagering-fixtures';

const movement = (money: Money, entryId = 'entry-1') => ({ entryId, transactionId: 'tx-1', money, at: T1 });

describe('opening', () => {
  test('with a positive balance: currency comes from the balance, version 1, equal dates', () => {
    const wallet = openWallet('1000.00');
    expect(wallet.id).toBe(WALLET_ID);
    expect(wallet.playerId).toBe(PLAYER_ID);
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.equals(brl('1000.00'))).toBe(true);
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt).toEqual(T0);
    expect(wallet.updatedAt).toEqual(T0);
  });

  test('with a zero balance', () => {
    const wallet = openWallet('0.00');
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test('a negative balance is invalid', () => {
    expect(() =>
      Wallet.open({ id: WALLET_ID, playerId: PLAYER_ID, initialBalance: brl('1.00').negate(), at: T0 }),
    ).toThrow(InvalidWalletError);
  });

  test('id and playerId are required', () => {
    expect(() => Wallet.open({ id: '', playerId: PLAYER_ID, initialBalance: brl('1.00'), at: T0 })).toThrow(InvalidWalletError);
    expect(() => Wallet.open({ id: WALLET_ID, playerId: '', initialBalance: brl('1.00'), at: T0 })).toThrow(InvalidWalletError);
  });

  test('openingEntry: CREDIT from 0 to the balance, at version 1, without changing the wallet', () => {
    const wallet = openWallet('1000.00');
    const entry = wallet.openingEntry({ entryId: 'entry-0', transactionId: 'tx-0', at: T0 });
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.walletVersion).toBe(1);
    expect(entry.balanceBefore.isZero()).toBe(true);
    expect(entry.balanceAfter.equals(brl('1000.00'))).toBe(true);
    expect(entry.money.equals(brl('1000.00'))).toBe(true);
    expect(wallet.version).toBe(1);
    expect(wallet.balance.equals(brl('1000.00'))).toBe(true);
  });

  test('openingEntry requires a positive balance and version 1', () => {
    const props = { entryId: 'e', transactionId: 't', at: T0 };
    expect(() => openWallet('0.00').openingEntry(props)).toThrow(InvalidWalletError);
    const moved = openWallet('10.00');
    moved.credit(movement(brl('1.00')));
    expect(() => moved.openingEntry(props)).toThrow(InvalidWalletError);
  });
});

describe('debit and credit', () => {
  test('a debit reduces the balance, bumps the version and returns the DEBIT entry', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.debit(movement(brl('80.00')));
    expect(wallet.balance.equals(brl('20.00'))).toBe(true);
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(T1);
    expect(wallet.createdAt).toEqual(T0);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.walletId).toBe(WALLET_ID);
    expect(entry.transactionId).toBe('tx-1');
    expect(entry.walletVersion).toBe(2);
    expect(entry.balanceBefore.equals(brl('100.00'))).toBe(true);
    expect(entry.balanceAfter.equals(brl('20.00'))).toBe(true);
  });

  test('a credit increases the balance, bumps the version and returns the CREDIT entry', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.credit(movement(brl('0.10')));
    expect(wallet.balance.equals(brl('100.10'))).toBe(true);
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
  });

  test('a debit can bring the balance to zero', () => {
    const wallet = openWallet('100.00');
    wallet.debit(movement(brl('100.00')));
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.balance.isNegative()).toBe(false);
  });

  test('the version increments once per movement', () => {
    const wallet = openWallet('100.00');
    wallet.debit(movement(brl('10.00')));
    wallet.credit(movement(brl('5.00')));
    wallet.debit(movement(brl('1.00')));
    expect(wallet.version).toBe(4);
    expect(wallet.balance.equals(brl('94.00'))).toBe(true);
  });

  test('insufficient funds throws and changes nothing', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.debit(movement(brl('100.01')))).toThrow(InsufficientFundsError);
    expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(T0);
  });

  test('a different currency throws and changes nothing', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.debit(movement(usd('1.00')))).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(movement(usd('1.00')))).toThrow(CurrencyMismatchError);
    expect(() => wallet.canDebit(usd('1.00'))).toThrow(CurrencyMismatchError);
    expect(() => wallet.canCredit(usd('1.00'))).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('a zero or negative amount is refused without changing anything', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.debit(movement(brl('0.00')))).toThrow(InvalidLedgerEntryError);
    expect(() => wallet.credit(movement(brl('0.00')))).toThrow(InvalidLedgerEntryError);
    expect(() => wallet.debit(movement(brl('5.00').negate()))).toThrow(InvalidLedgerEntryError);
    expect(() => wallet.credit(movement(brl('5.00').negate()))).toThrow(InvalidLedgerEntryError);
    expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test('canDebit and canCredit query without changing anything', () => {
    const wallet = openWallet('100.00');
    expect(wallet.canDebit(brl('100.00'))).toBe(true);
    expect(wallet.canDebit(brl('100.01'))).toBe(false);
    expect(wallet.canCredit(brl('1.00'))).toBe(true);
    expect(openWallet('999999999999999999.99').canCredit(brl('0.01'))).toBe(false);
    expect(wallet.version).toBe(1);
  });
});

describe('encapsulation and rehydration', () => {
  test('changing the received or exposed Date objects does not affect the wallet', () => {
    const at = new Date(T0);
    const wallet = Wallet.open({ id: WALLET_ID, playerId: PLAYER_ID, initialBalance: brl('1.00'), at });
    at.setFullYear(2000);
    wallet.updatedAt.setFullYear(2000);
    wallet.createdAt.setFullYear(2000);
    expect(wallet.updatedAt).toEqual(T0);
    expect(wallet.createdAt).toEqual(T0);
  });

  test('rehydrate rebuilds the state without revalidating', () => {
    const wallet = Wallet.rehydrate({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      currency: 'BRL',
      balance: brl('5.00').negate(), // inválido para open; a reidratação só reconstrói
      version: 7,
      createdAt: T0,
      updatedAt: T1,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.isNegative()).toBe(true);
    expect(wallet.updatedAt).toEqual(T1);
  });

  test('a rehydrated wallet keeps applying the rules', () => {
    const wallet = Wallet.rehydrate({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      currency: 'BRL',
      balance: brl('10.00'),
      version: 3,
      createdAt: T0,
      updatedAt: T0,
    });
    const entry = wallet.debit(movement(brl('10.00')));
    expect(entry.walletVersion).toBe(4);
    expect(() => wallet.debit(movement(brl('0.01')))).toThrow(InsufficientFundsError);
  });
});
