import { describe, expect, test } from 'bun:test';
import { InvalidMoneyError, Money } from '../../src/shared/domain/money';
import { moneyFromColumn, moneyToColumn } from '../../src/shared/infrastructure/persistence/money-column';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money and the NUMERIC(20,2) column', () => {
  test.each(['0.00', '0.01', '0.10', '25.00', '999999999999999999.99'])('lossless round trip: %s', (amount) => {
    const column = moneyToColumn(brl(amount));
    expect(column).toBe(amount);
    expect(typeof column).toBe('string');
    expect(moneyFromColumn(column, 'BRL').equals(brl(amount))).toBe(true);
  });

  test('a value that does not fit in a number comes back exact', () => {
    const column = '123456789012345678.91';
    expect(moneyToColumn(moneyFromColumn(column, 'BRL'))).toBe(column);
  });

  test('internal negatives: round trip preserves the sign', () => {
    const debt = brl('15.50').negate();
    const column = moneyToColumn(debt);
    expect(column).toBe('-15.50');
    const read = moneyFromColumn(column, 'BRL');
    expect(read.isNegative()).toBe(true);
    expect(read.equals(debt)).toBe(true);
  });

  test('preserves the currency', () => {
    expect(moneyFromColumn('1.00', 'USD').currency).toBe('USD');
  });

  test.each([['1.5'], ['1'], ['1e3'], ['-1'], ['NaN'], ['']])('a value outside the format is not accepted: "%s"', (amount) => {
    expect(() => moneyFromColumn(amount, 'BRL')).toThrow(InvalidMoneyError);
  });

  test('a number coming from a misconfigured driver is refused', () => {
    expect(() => moneyFromColumn(25.5 as unknown as string, 'BRL')).toThrow(InvalidMoneyError);
  });
});
