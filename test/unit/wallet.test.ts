import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, Money } from '../../src/shared/domain/money';
import { LedgerDirection } from '../../src/wallet/domain/ledger-entry';
import { Wallet } from '../../src/wallet/domain/wallet';
import { InsufficientFundsError, InvalidLedgerEntryError, InvalidWalletError } from '../../src/wallet/domain/wallet-errors';
import { brl, openWallet, PLAYER_ID, T0, T1, usd, WALLET_ID } from '../support/wagering-fixtures';

const movement = (money: Money, entryId = 'entry-1') => ({ entryId, transactionId: 'tx-1', money, at: T1 });

describe('abertura', () => {
  test('com saldo positivo: moeda vem do saldo, versão 1, datas iguais', () => {
    const wallet = openWallet('1000.00');
    expect(wallet.id).toBe(WALLET_ID);
    expect(wallet.playerId).toBe(PLAYER_ID);
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.equals(brl('1000.00'))).toBe(true);
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt).toEqual(T0);
    expect(wallet.updatedAt).toEqual(T0);
  });

  test('com saldo zero', () => {
    const wallet = openWallet('0.00');
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test('saldo negativo é inválido', () => {
    expect(() =>
      Wallet.open({ id: WALLET_ID, playerId: PLAYER_ID, initialBalance: brl('1.00').negate(), at: T0 }),
    ).toThrow(InvalidWalletError);
  });

  test('id e playerId são obrigatórios', () => {
    expect(() => Wallet.open({ id: '', playerId: PLAYER_ID, initialBalance: brl('1.00'), at: T0 })).toThrow(InvalidWalletError);
    expect(() => Wallet.open({ id: WALLET_ID, playerId: '', initialBalance: brl('1.00'), at: T0 })).toThrow(InvalidWalletError);
  });

  test('openingEntry: CREDIT de 0 ao saldo, na versão 1, sem alterar a wallet', () => {
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

  test('openingEntry exige saldo positivo e versão 1', () => {
    const props = { entryId: 'e', transactionId: 't', at: T0 };
    expect(() => openWallet('0.00').openingEntry(props)).toThrow(InvalidWalletError);
    const moved = openWallet('10.00');
    moved.credit(movement(brl('1.00')));
    expect(() => moved.openingEntry(props)).toThrow(InvalidWalletError);
  });
});

describe('débito e crédito', () => {
  test('débito reduz o saldo, sobe a versão e devolve o lançamento DEBIT', () => {
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

  test('crédito aumenta o saldo, sobe a versão e devolve o lançamento CREDIT', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.credit(movement(brl('0.10')));
    expect(wallet.balance.equals(brl('100.10'))).toBe(true);
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
  });

  test('o débito pode zerar o saldo', () => {
    const wallet = openWallet('100.00');
    wallet.debit(movement(brl('100.00')));
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.balance.isNegative()).toBe(false);
  });

  test('a versão incrementa uma vez por movimento', () => {
    const wallet = openWallet('100.00');
    wallet.debit(movement(brl('10.00')));
    wallet.credit(movement(brl('5.00')));
    wallet.debit(movement(brl('1.00')));
    expect(wallet.version).toBe(4);
    expect(wallet.balance.equals(brl('94.00'))).toBe(true);
  });

  test('saldo insuficiente lança erro e não altera nada', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.debit(movement(brl('100.01')))).toThrow(InsufficientFundsError);
    expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(T0);
  });

  test('moeda diferente lança erro e não altera nada', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.debit(movement(usd('1.00')))).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(movement(usd('1.00')))).toThrow(CurrencyMismatchError);
    expect(() => wallet.canDebit(usd('1.00'))).toThrow(CurrencyMismatchError);
    expect(() => wallet.canCredit(usd('1.00'))).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('valor zero ou negativo é recusado sem alterar nada', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.debit(movement(brl('0.00')))).toThrow(InvalidLedgerEntryError);
    expect(() => wallet.credit(movement(brl('0.00')))).toThrow(InvalidLedgerEntryError);
    expect(() => wallet.debit(movement(brl('5.00').negate()))).toThrow(InvalidLedgerEntryError);
    expect(() => wallet.credit(movement(brl('5.00').negate()))).toThrow(InvalidLedgerEntryError);
    expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test('canDebit e canCredit consultam sem alterar', () => {
    const wallet = openWallet('100.00');
    expect(wallet.canDebit(brl('100.00'))).toBe(true);
    expect(wallet.canDebit(brl('100.01'))).toBe(false);
    expect(wallet.canCredit(brl('1.00'))).toBe(true);
    expect(openWallet('999999999999999999.99').canCredit(brl('0.01'))).toBe(false);
    expect(wallet.version).toBe(1);
  });
});

describe('encapsulamento e reidratação', () => {
  test('alterar os Date recebidos ou expostos não afeta a wallet', () => {
    const at = new Date(T0);
    const wallet = Wallet.open({ id: WALLET_ID, playerId: PLAYER_ID, initialBalance: brl('1.00'), at });
    at.setFullYear(2000);
    wallet.updatedAt.setFullYear(2000);
    wallet.createdAt.setFullYear(2000);
    expect(wallet.updatedAt).toEqual(T0);
    expect(wallet.createdAt).toEqual(T0);
  });

  test('rehydrate reconstrói o estado sem revalidar', () => {
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

  test('wallet reidratada continua aplicando as regras', () => {
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
