import { describe, expect, test } from 'bun:test';
import { InvalidMoneyError, Money } from '../../src/shared/domain/money';
import { moneyFromColumn, moneyToColumn } from '../../src/shared/infrastructure/persistence/money-column';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money e coluna NUMERIC(20,2)', () => {
  test.each(['0.00', '0.01', '0.10', '25.00', '999999999999999999.99'])('ida e volta sem perda: %s', (amount) => {
    const column = moneyToColumn(brl(amount));
    expect(column).toBe(amount);
    expect(typeof column).toBe('string');
    expect(moneyFromColumn(column, 'BRL').equals(brl(amount))).toBe(true);
  });

  test('valor que não cabe em number volta exato', () => {
    const column = '123456789012345678.91';
    expect(moneyToColumn(moneyFromColumn(column, 'BRL'))).toBe(column);
  });

  test('negativos internos: ida e volta preserva o sinal', () => {
    const debt = brl('15.50').negate();
    const column = moneyToColumn(debt);
    expect(column).toBe('-15.50');
    const read = moneyFromColumn(column, 'BRL');
    expect(read.isNegative()).toBe(true);
    expect(read.equals(debt)).toBe(true);
  });

  test('preserva a moeda', () => {
    expect(moneyFromColumn('1.00', 'USD').currency).toBe('USD');
  });

  test.each([['1.5'], ['1'], ['1e3'], ['-1'], ['NaN'], ['']])('valor fora do formato não é aceito: "%s"', (amount) => {
    expect(() => moneyFromColumn(amount, 'BRL')).toThrow(InvalidMoneyError);
  });

  test('number vindo de um driver mal configurado é recusado', () => {
    expect(() => moneyFromColumn(25.5 as unknown as string, 'BRL')).toThrow(InvalidMoneyError);
  });
});
