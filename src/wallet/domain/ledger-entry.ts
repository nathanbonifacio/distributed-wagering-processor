import { Money } from '../../shared/domain/money';
import { InvalidLedgerEntryError } from './wallet-errors';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  /** Versão da wallet depois deste lançamento: liga saldo e ledger (UNIQUE no banco). */
  walletVersion: number;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

/** Lançamento imutável: sem campos mutáveis e sem métodos de transição. */
export class WalletLedgerEntry {
  public readonly id: string;
  public readonly walletId: string;
  public readonly transactionId: string;
  public readonly walletVersion: number;
  public readonly direction: LedgerDirection;
  public readonly money: Money;
  public readonly balanceBefore: Money;
  public readonly balanceAfter: Money;
  private readonly _createdAt: Date;

  private constructor(state: LedgerEntryState) {
    this.id = state.id;
    this.walletId = state.walletId;
    this.transactionId = state.transactionId;
    this.walletVersion = state.walletVersion;
    this.direction = state.direction;
    this.money = state.money;
    this.balanceBefore = state.balanceBefore;
    this.balanceAfter = state.balanceAfter;
    this._createdAt = new Date(state.createdAt);
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.id || !props.walletId || !props.transactionId) {
      throw new InvalidLedgerEntryError('id, walletId e transactionId são obrigatórios');
    }
    if (!Number.isInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new InvalidLedgerEntryError('walletVersion deve ser um inteiro >= 1');
    }
    const { money, balanceBefore, balanceAfter } = props;
    if (money.currency !== balanceBefore.currency || money.currency !== balanceAfter.currency) {
      throw new InvalidLedgerEntryError('valor e saldos precisam estar na mesma moeda');
    }
    if (!money.isPositive()) {
      throw new InvalidLedgerEntryError('o valor do lançamento deve ser estritamente positivo');
    }
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('o lançamento não pode registrar saldo negativo');
    }
    const entry = new WalletLedgerEntry(props);
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError('aritmética inconsistente: saldo anterior ± valor difere do saldo posterior');
    }
    return entry;
  }

  /** Reconstrução a partir da persistência: não revalida. Use isBalanced() para auditar. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state);
  }

  /** Cópia: um Date é mutável e não pode expor o estado interno. */
  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  /** balanceBefore ± money === balanceAfter. */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
