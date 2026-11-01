import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  Money,
  MoneyOverflowError,
  type MoneyProps,
} from '../../src/shared/domain/money';
import { DomainError } from '../../src/shared/domain/domain-error';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
const MAX = '999999999999999999.99';

describe('creation', () => {
  test('valid values preserve the amount and the currency', () => {
    expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(brl('0.01').toJSON()).toEqual({ amount: '0.01', currency: 'BRL' });
    expect(brl('1000.50').toJSON()).toEqual({ amount: '1000.50', currency: 'BRL' });
    expect(brl('0.00').isZero()).toBe(true);
  });

  test('zero(currency) creates a zero value in the given currency', () => {
    const zero = Money.zero('BRL');
    expect(zero.isZero()).toBe(true);
    expect(zero.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(Money.zero('USD').currency).toBe('USD');
  });

  test('the upper limit (18 integer digits) is accepted', () => {
    expect(brl(MAX).toJSON().amount).toBe(MAX);
  });

  test('the model is multi-currency', () => {
    expect(usd('1.00').currency).toBe('USD');
    expect(Money.from({ amount: '1.00', currency: 'EUR' }).currency).toBe('EUR');
  });
});

describe('invalid inputs (nothing is rounded or corrected)', () => {
  const invalidAmounts: Array<[string, unknown]> = [
    ['empty string', ''],
    ['only spaces', '  '],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['-Infinity', '-Infinity'],
    ['scientific notation', '1e3'],
    ['scientific notation with decimals', '1.00e2'],
    ['uppercase scientific notation', '1E2'],
    ['hexadecimal', '0x10'],
    ['no decimal places', '25'],
    ['one decimal place', '25.5'],
    ['three decimal places', '25.001'],
    ['three places, ending in zero', '25.000'],
    ['more places than allowed, even if it would round down', '0.004'],
    ['dot without decimals', '25.'],
    ['no integer part', '.50'],
    ['comma as separator', '25,00'],
    ['thousands separator', '1,000.00'],
    ['negative', '-1.00'],
    ['negative zero', '-0.00'],
    ['plus sign', '+1.00'],
    ['space before', ' 25.00'],
    ['space after', '25.00 '],
    ['trailing newline', '25.00\n'],
    ['leading zeros', '007.00'],
    ['19 integer digits', '1000000000000000000.00'],
    ['non-ASCII digits', '٢٥.٠٠'],
    ['text', 'abc'],
    ['two decimal points', '1.00.00'],
    ['number (JSON without quotes)', 25],
    ['number with decimals', 25.5],
    ['null', null],
    ['undefined', undefined],
    ['boolean', true],
    ['object', {}],
    ['array', ['25.00']],
  ];
  test.each(invalidAmounts)('invalid amount: %s', (_label, amount) => {
    expect(() => Money.from({ amount, currency: 'BRL' } as unknown as MoneyProps)).toThrow(InvalidMoneyError);
  });

  const invalidCurrencies: Array<[string, unknown]> = [
    ['empty', ''],
    ['lowercase', 'brl'],
    ['2 letters', 'BR'],
    ['4 letters', 'BRLL'],
    ['with a digit', 'BR1'],
    ['with a space', 'BR '],
    ['undefined', undefined],
    ['number', 986],
  ];
  test.each(invalidCurrencies)('invalid currency: %s', (_label, currency) => {
    expect(() => Money.from({ amount: '1.00', currency } as unknown as MoneyProps)).toThrow(InvalidMoneyError);
    expect(() => Money.zero(currency as string)).toThrow(InvalidMoneyError);
  });

  test('absent props or a non-object', () => {
    expect(() => Money.from(null as unknown as MoneyProps)).toThrow(InvalidMoneyError);
    expect(() => Money.from(undefined as unknown as MoneyProps)).toThrow(InvalidMoneyError);
    expect(() => Money.from('25.00' as unknown as MoneyProps)).toThrow(InvalidMoneyError);
  });

  test('errors are domain errors, with a stable code', () => {
    try {
      brl('25');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      expect((e as InvalidMoneyError).code).toBe('INVALID_MONEY');
      expect((e as Error).name).toBe('InvalidMoneyError');
    }
  });
});

describe('exact arithmetic', () => {
  test('0.10 + 0.20 = 0.30 (the floating-point classic)', () => {
    const sum = brl('0.10').add(brl('0.20'));
    expect(sum.toJSON().amount).toBe('0.30');
    expect(sum.equals(brl('0.30'))).toBe(true);
  });

  test('addition and subtraction', () => {
    expect(brl('100.00').add(brl('25.50')).toJSON().amount).toBe('125.50');
    expect(brl('100.00').subtract(brl('80.00')).toJSON().amount).toBe('20.00');
    expect(brl('0.30').subtract(brl('0.10')).toJSON().amount).toBe('0.20');
  });

  test('subtraction can be negative internally (the Wallet is what forbids a negative balance)', () => {
    const result = brl('10.00').subtract(brl('25.00'));
    expect(result.isNegative()).toBe(true);
    expect(result.toJSON().amount).toBe('-15.00');
  });

  test('10,000 additions of 0.01 result in exactly 100.00', () => {
    let total = Money.zero('BRL');
    const cent = brl('0.01');
    for (let i = 0; i < 10_000; i++) total = total.add(cent);
    expect(total.toJSON().amount).toBe('100.00');
  });

  test('negate flips the sign and is an involution', () => {
    const value = brl('25.00');
    expect(value.negate().toJSON().amount).toBe('-25.00');
    expect(value.negate().negate().equals(value)).toBe(true);
    expect(value.negate().isNegative()).toBe(true);
  });

  test('zero is never negative: negate(0) = "0.00", never "-0.00"', () => {
    const z = Money.zero('BRL').negate();
    expect(z.toJSON().amount).toBe('0.00');
    expect(z.toString()).toBe('0.00 BRL');
    expect(z.isNegative()).toBe(false);
    expect(z.isZero()).toBe(true);
    expect(brl('5.00').subtract(brl('5.00')).toJSON().amount).toBe('0.00');
  });

  test('a - a = 0 e a + (-a) = 0', () => {
    const a = brl('123.45');
    expect(a.subtract(a).isZero()).toBe(true);
    expect(a.add(a.negate()).isZero()).toBe(true);
  });

  test('serialization always keeps 2 decimal places', () => {
    expect(brl('5.10').toJSON().amount).toBe('5.10');
    expect(brl('5.00').add(brl('0.00')).toJSON().amount).toBe('5.00');
    expect(brl('1.00').subtract(brl('0.99')).toJSON().amount).toBe('0.01');
  });
});

describe('large values', () => {
  test('exact arithmetic at the 18-digit limit', () => {
    expect(brl(MAX).subtract(brl('0.01')).toJSON().amount).toBe('999999999999999999.98');
    expect(brl('999999999999999999.98').add(brl('0.01')).toJSON().amount).toBe(MAX);
    expect(brl('500000000000000000.00').add(brl('499999999999999999.99')).toJSON().amount).toBe(MAX);
  });

  test('adding past the limit throws MoneyOverflowError instead of losing precision', () => {
    expect(() => brl(MAX).add(brl('0.01'))).toThrow(MoneyOverflowError);
    expect(() => brl(MAX).add(brl(MAX))).toThrow(MoneyOverflowError);
    expect(() => brl(MAX).negate().subtract(brl('0.01'))).toThrow(MoneyOverflowError);
    expect(() => brl(MAX).add(brl('0.01'))).toThrow(DomainError);
  });
});

describe('comparisons', () => {
  test('isZero / isPositive / isNegative', () => {
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.00').isPositive()).toBe(false);
    expect(brl('0.00').isNegative()).toBe(false);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').isZero()).toBe(false);
    expect(brl('0.01').negate().isNegative()).toBe(true);
    expect(brl('0.01').negate().isPositive()).toBe(false);
  });

  test('isLessThan is strict', () => {
    expect(brl('20.00').isLessThan(brl('80.00'))).toBe(true);
    expect(brl('80.00').isLessThan(brl('20.00'))).toBe(false);
    expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
    expect(brl('0.29').isLessThan(brl('0.30'))).toBe(true);
    expect(brl('10.00').negate().isLessThan(Money.zero('BRL'))).toBe(true);
  });

  test('equals compares amount and currency', () => {
    expect(brl('25.00').equals(brl('25.00'))).toBe(true);
    expect(brl('25.00').equals(brl('25.01'))).toBe(false);
    expect(brl('0.00').equals(Money.zero('BRL'))).toBe(true);
    expect(brl('25.00').equals(usd('25.00'))).toBe(false); // moedas diferentes nunca são iguais
  });
});

describe('different currencies', () => {
  test('add, subtract and isLessThan throw CurrencyMismatchError', () => {
    expect(() => brl('1.00').add(usd('1.00'))).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd('1.00'))).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd('1.00'))).toThrow(CurrencyMismatchError);
  });

  test('the error is a domain error, has a stable code and names the currencies', () => {
    try {
      brl('1.00').add(usd('1.00'));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      expect((e as CurrencyMismatchError).code).toBe('CURRENCY_MISMATCH');
      expect((e as Error).message).toContain('BRL');
      expect((e as Error).message).toContain('USD');
    }
  });

  test('zero in different currencies does not combine either', () => {
    expect(() => Money.zero('BRL').add(Money.zero('USD'))).toThrow(CurrencyMismatchError);
  });
});

describe('serialization', () => {
  test('toJSON returns MoneyProps with a decimal string (never a number or a Money)', () => {
    const json = brl('25.00').toJSON();
    expect(typeof json.amount).toBe('string');
    expect(Object.keys(json).sort()).toEqual(['amount', 'currency']);
  });

  test('JSON.stringify uses toJSON', () => {
    expect(JSON.stringify({ money: brl('975.00') })).toBe('{"money":{"amount":"975.00","currency":"BRL"}}');
    expect(JSON.stringify(brl('0.10'))).toBe('{"amount":"0.10","currency":"BRL"}');
  });

  test('round trip: from(toJSON()) reproduces the value', () => {
    for (const amount of ['0.00', '0.01', '25.00', '1000.50', MAX]) {
      const original = brl(amount);
      expect(Money.from(original.toJSON()).equals(original)).toBe(true);
    }
  });

  test('readable toString, always with 2 decimal places and no scientific notation', () => {
    expect(brl('25.00').toString()).toBe('25.00 BRL');
    expect(brl('0.01').toString()).toBe('0.01 BRL');
    expect(brl('0.00').toString()).toBe('0.00 BRL');
    expect(brl(MAX).toString()).toBe(`${MAX} BRL`);
    expect(brl('10.00').negate().toString()).toBe('-10.00 BRL');
  });
});

describe('immutability', () => {
  test('operations return new instances and do not change their operands', () => {
    const a = brl('10.00');
    const b = brl('5.00');
    const sum = a.add(b);
    const diff = a.subtract(b);
    const neg = a.negate();
    expect(sum).not.toBe(a);
    expect(diff).not.toBe(a);
    expect(neg).not.toBe(a);
    expect(a.toJSON().amount).toBe('10.00');
    expect(b.toJSON().amount).toBe('5.00');
  });

  test('the instance is frozen: it accepts neither reassignment nor new properties', () => {
    const money = brl('10.00');
    expect(Object.isFrozen(money)).toBe(true);
    expect(() => { (money as unknown as { currency: string }).currency = 'USD'; }).toThrow(TypeError);
    expect(() => { (money as unknown as Record<string, unknown>).extra = 1; }).toThrow(TypeError);
    expect(money.currency).toBe('BRL');
    expect(money.toJSON().amount).toBe('10.00');
  });

  test('changing the object returned by toJSON does not affect the Money', () => {
    const money = brl('10.00');
    const json = money.toJSON();
    json.amount = '999.00';
    json.currency = 'USD';
    expect(money.toJSON()).toEqual({ amount: '10.00', currency: 'BRL' });
  });

  test('changing the input object after from does not affect the Money', () => {
    const props = { amount: '10.00', currency: 'BRL' };
    const money = Money.from(props);
    props.amount = '999.00';
    expect(money.toJSON().amount).toBe('10.00');
  });

  test('the constructor is private: instantiating directly is not allowed by the type', () => {
    // @ts-expect-error construtor privado: só as factories criam Money
    void new Money(null, 'BRL');
  });
});

describe('properties (BigInt oracle, independent of decimal.js)', () => {
  // PRNG determinístico (LCG): o teste é reproduzível, sem flakiness.
  let seed = 123456789n;
  const next = (bound: bigint) => {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
    return (seed >> 11n) % bound;
  };
  const toCents = (m: Money) => BigInt(m.toJSON().amount.replace('.', ''));
  const fromCents = (cents: bigint) => {
    const sign = cents < 0n ? '-' : '';
    const abs = (cents < 0n ? -cents : cents).toString().padStart(3, '0');
    return `${sign}${abs.slice(0, -2)}.${abs.slice(-2)}`;
  };

  test('500 random pairs: addition, subtraction and comparison match the oracle', () => {
    for (let i = 0; i < 500; i++) {
      const x = next(10n ** 17n);
      const y = next(10n ** 17n);
      const a = brl(fromCents(x));
      const b = brl(fromCents(y));
      expect(a.add(b).toJSON().amount).toBe(fromCents(x + y));
      expect(a.subtract(b).toJSON().amount).toBe(fromCents(x - y));
      expect(a.isLessThan(b)).toBe(x < y);
      expect(a.equals(b)).toBe(x === y);
      expect(toCents(a.add(b).subtract(b))).toBe(x);
    }
  });
});
