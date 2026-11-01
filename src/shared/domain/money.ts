import Decimal from 'decimal.js';
import { DomainError } from './domain-error';

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';
}

export class MoneyOverflowError extends DomainError {
  readonly code = 'MONEY_OVERFLOW';
}

const D = Decimal.clone({ precision: 40 });
type Dec = InstanceType<typeof D>;

const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const LIMIT = new D('1e18');

export class Money {
  private constructor(
    private readonly value: Dec,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('Money.from expects an object { amount, currency }');
    }
    const { amount, currency } = props;
    Money.assertCurrency(currency);
    if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        'invalid amount: use a non-negative decimal string with exactly 2 decimal places (e.g. "25.00")',
      );
    }
    return new Money(new D(amount), currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(new D(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.of(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.gt(0);
  }

  isNegative(): boolean {
    return this.value.lt(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lt(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.eq(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private static of(value: Dec, currency: string): Money {
    if (value.abs().gte(LIMIT)) {
      throw new MoneyOverflowError('value exceeds the limit of 18 integer digits');
    }
    return new Money(value.isZero() ? new D(0) : value, currency);
  }

  private static assertCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError('invalid currency: use a 3-letter uppercase ISO-4217 code (e.g. "BRL")');
    }
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(`different currencies: ${this.currency} and ${other.currency}`);
    }
  }
}
