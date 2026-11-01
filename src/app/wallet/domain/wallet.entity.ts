import { CurrencyMismatchError, Money, MoneyOverflowError } from '../../../shared/domain/money';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry.entity';
import { InsufficientFundsError, InvalidWalletError } from './wallet-errors';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
}

export interface WalletMovement {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export interface OpeningEntryProps {
  entryId: string;
  transactionId: string;
  at: Date;
}

/**
 * Aggregate Root. Toda alteração de saldo passa por debit/credit, que devolvem o lançamento,
 * então não existe mudança de saldo sem ledger. Unicidade por (playerId, currency) e proteção
 * contra lost update são do banco e da camada transacional.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    private readonly _createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): Wallet {
    if (!props.id || !props.playerId) {
      throw new InvalidWalletError('id and playerId are required');
    }
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError('the initial balance cannot be negative');
    }
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      new Date(props.at),
      new Date(props.at),
    );
  }

  /** Reconstrução a partir da persistência: não revalida. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt),
      new Date(state.updatedAt),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt);
  }

  /** Permite decidir uma rejeição antes de alterar qualquer estado. */
  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  /** false quando o crédito ultrapassaria o limite representável de Money. */
  canCredit(money: Money): boolean {
    this.assertSameCurrency(money);
    try {
      this._balance.add(money);
      return true;
    } catch (error) {
      if (error instanceof MoneyOverflowError) return false;
      throw error;
    }
  }

  debit(movement: WalletMovement): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    if (this._balance.isLessThan(movement.money)) {
      throw new InsufficientFundsError(`insufficient funds in wallet ${this.id}`);
    }
    return this.apply(LedgerDirection.Debit, this._balance.subtract(movement.money), movement);
  }

  credit(movement: WalletMovement): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    return this.apply(LedgerDirection.Credit, this._balance.add(movement.money), movement);
  }

  /**
   * Lançamento CREDIT do saldo de abertura (0 → saldo inicial). Não altera a wallet: o saldo já
   * nasceu aplicado e o lançamento ocupa a versão 1, porque o README mostra `version: 1` após criar.
   */
  openingEntry(props: OpeningEntryProps): WalletLedgerEntry {
    if (this._version !== 1 || !this._balance.isPositive()) {
      throw new InvalidWalletError('the opening entry requires a wallet at version 1 with a positive balance');
    }
    return WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      walletVersion: 1,
      direction: LedgerDirection.Credit,
      money: this._balance,
      balanceBefore: Money.zero(this.currency),
      balanceAfter: this._balance,
      createdAt: props.at,
    });
  }

  /** Cria o lançamento antes de mudar o estado: se ele for inválido, a wallet fica intacta. */
  private apply(direction: LedgerDirection, balanceAfter: Money, movement: WalletMovement): WalletLedgerEntry {
    const version = this._version + 1;
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      walletVersion: version,
      direction,
      money: movement.money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: movement.at,
    });
    this._balance = balanceAfter;
    this._version = version;
    this._updatedAt = new Date(movement.at);
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(`currency ${money.currency} is incompatible with the wallet currency ${this.currency}`);
    }
  }
}
