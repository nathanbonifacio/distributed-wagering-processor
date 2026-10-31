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

describe('criação', () => {
  test('valores válidos preservam o valor e a moeda', () => {
    expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(brl('0.01').toJSON()).toEqual({ amount: '0.01', currency: 'BRL' });
    expect(brl('1000.50').toJSON()).toEqual({ amount: '1000.50', currency: 'BRL' });
    expect(brl('0.00').isZero()).toBe(true);
  });

  test('zero(currency) cria valor zero na moeda informada', () => {
    const zero = Money.zero('BRL');
    expect(zero.isZero()).toBe(true);
    expect(zero.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(Money.zero('USD').currency).toBe('USD');
  });

  test('o limite superior (18 dígitos inteiros) é aceito', () => {
    expect(brl(MAX).toJSON().amount).toBe(MAX);
  });

  test('o modelo é multi-moeda', () => {
    expect(usd('1.00').currency).toBe('USD');
    expect(Money.from({ amount: '1.00', currency: 'EUR' }).currency).toBe('EUR');
  });
});

describe('entradas inválidas (nada é arredondado nem corrigido)', () => {
  const invalidAmounts: Array<[string, unknown]> = [
    ['string vazia', ''],
    ['só espaços', '  '],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['-Infinity', '-Infinity'],
    ['notação científica', '1e3'],
    ['notação científica com casas', '1.00e2'],
    ['notação científica maiúscula', '1E2'],
    ['hexadecimal', '0x10'],
    ['sem casas decimais', '25'],
    ['uma casa decimal', '25.5'],
    ['três casas decimais', '25.001'],
    ['três casas, terminando em zero', '25.000'],
    ['mais casas que o permitido, mesmo que arredondasse para baixo', '0.004'],
    ['ponto sem casas', '25.'],
    ['sem parte inteira', '.50'],
    ['vírgula como separador', '25,00'],
    ['separador de milhar', '1,000.00'],
    ['negativo', '-1.00'],
    ['negativo zero', '-0.00'],
    ['sinal positivo', '+1.00'],
    ['espaço antes', ' 25.00'],
    ['espaço depois', '25.00 '],
    ['quebra de linha final', '25.00\n'],
    ['zeros à esquerda', '007.00'],
    ['19 dígitos inteiros', '1000000000000000000.00'],
    ['dígitos não ASCII', '٢٥.٠٠'],
    ['texto', 'abc'],
    ['duas vírgulas decimais', '1.00.00'],
    ['number (JSON sem aspas)', 25],
    ['number com casas', 25.5],
    ['null', null],
    ['undefined', undefined],
    ['boolean', true],
    ['objeto', {}],
    ['array', ['25.00']],
  ];
  test.each(invalidAmounts)('amount inválido: %s', (_label, amount) => {
    expect(() => Money.from({ amount, currency: 'BRL' } as unknown as MoneyProps)).toThrow(InvalidMoneyError);
  });

  const invalidCurrencies: Array<[string, unknown]> = [
    ['vazia', ''],
    ['minúscula', 'brl'],
    ['2 letras', 'BR'],
    ['4 letras', 'BRLL'],
    ['com número', 'BR1'],
    ['com espaço', 'BR '],
    ['undefined', undefined],
    ['number', 986],
  ];
  test.each(invalidCurrencies)('currency inválida: %s', (_label, currency) => {
    expect(() => Money.from({ amount: '1.00', currency } as unknown as MoneyProps)).toThrow(InvalidMoneyError);
    expect(() => Money.zero(currency as string)).toThrow(InvalidMoneyError);
  });

  test('props ausentes ou não-objeto', () => {
    expect(() => Money.from(null as unknown as MoneyProps)).toThrow(InvalidMoneyError);
    expect(() => Money.from(undefined as unknown as MoneyProps)).toThrow(InvalidMoneyError);
    expect(() => Money.from('25.00' as unknown as MoneyProps)).toThrow(InvalidMoneyError);
  });

  test('erros são de domínio, com code estável', () => {
    try {
      brl('25');
      throw new Error('deveria lançar');
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      expect((e as InvalidMoneyError).code).toBe('INVALID_MONEY');
      expect((e as Error).name).toBe('InvalidMoneyError');
    }
  });
});

describe('aritmética exata', () => {
  test('0.10 + 0.20 = 0.30 (o clássico do ponto flutuante)', () => {
    const sum = brl('0.10').add(brl('0.20'));
    expect(sum.toJSON().amount).toBe('0.30');
    expect(sum.equals(brl('0.30'))).toBe(true);
  });

  test('soma e subtração', () => {
    expect(brl('100.00').add(brl('25.50')).toJSON().amount).toBe('125.50');
    expect(brl('100.00').subtract(brl('80.00')).toJSON().amount).toBe('20.00');
    expect(brl('0.30').subtract(brl('0.10')).toJSON().amount).toBe('0.20');
  });

  test('subtração pode resultar em negativo internamente (a Wallet é quem proíbe saldo negativo)', () => {
    const result = brl('10.00').subtract(brl('25.00'));
    expect(result.isNegative()).toBe(true);
    expect(result.toJSON().amount).toBe('-15.00');
  });

  test('10.000 somas de 0.01 resultam em exatamente 100.00', () => {
    let total = Money.zero('BRL');
    const cent = brl('0.01');
    for (let i = 0; i < 10_000; i++) total = total.add(cent);
    expect(total.toJSON().amount).toBe('100.00');
  });

  test('negate inverte o sinal e é involutivo', () => {
    const value = brl('25.00');
    expect(value.negate().toJSON().amount).toBe('-25.00');
    expect(value.negate().negate().equals(value)).toBe(true);
    expect(value.negate().isNegative()).toBe(true);
  });

  test('zero nunca é negativo: negate(0) = "0.00", sem "-0.00"', () => {
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

  test('a serialização mantém sempre 2 casas', () => {
    expect(brl('5.10').toJSON().amount).toBe('5.10');
    expect(brl('5.00').add(brl('0.00')).toJSON().amount).toBe('5.00');
    expect(brl('1.00').subtract(brl('0.99')).toJSON().amount).toBe('0.01');
  });
});

describe('valores elevados', () => {
  test('aritmética exata no limite de 18 dígitos', () => {
    expect(brl(MAX).subtract(brl('0.01')).toJSON().amount).toBe('999999999999999999.98');
    expect(brl('999999999999999999.98').add(brl('0.01')).toJSON().amount).toBe(MAX);
    expect(brl('500000000000000000.00').add(brl('499999999999999999.99')).toJSON().amount).toBe(MAX);
  });

  test('somar além do limite lança MoneyOverflowError em vez de perder precisão', () => {
    expect(() => brl(MAX).add(brl('0.01'))).toThrow(MoneyOverflowError);
    expect(() => brl(MAX).add(brl(MAX))).toThrow(MoneyOverflowError);
    expect(() => brl(MAX).negate().subtract(brl('0.01'))).toThrow(MoneyOverflowError);
    expect(() => brl(MAX).add(brl('0.01'))).toThrow(DomainError);
  });
});

describe('comparações', () => {
  test('isZero / isPositive / isNegative', () => {
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.00').isPositive()).toBe(false);
    expect(brl('0.00').isNegative()).toBe(false);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').isZero()).toBe(false);
    expect(brl('0.01').negate().isNegative()).toBe(true);
    expect(brl('0.01').negate().isPositive()).toBe(false);
  });

  test('isLessThan é estrito', () => {
    expect(brl('20.00').isLessThan(brl('80.00'))).toBe(true);
    expect(brl('80.00').isLessThan(brl('20.00'))).toBe(false);
    expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
    expect(brl('0.29').isLessThan(brl('0.30'))).toBe(true);
    expect(brl('10.00').negate().isLessThan(Money.zero('BRL'))).toBe(true);
  });

  test('equals compara valor e moeda', () => {
    expect(brl('25.00').equals(brl('25.00'))).toBe(true);
    expect(brl('25.00').equals(brl('25.01'))).toBe(false);
    expect(brl('0.00').equals(Money.zero('BRL'))).toBe(true);
    expect(brl('25.00').equals(usd('25.00'))).toBe(false); // moedas diferentes nunca são iguais
  });
});

describe('moedas diferentes', () => {
  test('add, subtract e isLessThan lançam CurrencyMismatchError', () => {
    expect(() => brl('1.00').add(usd('1.00'))).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd('1.00'))).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd('1.00'))).toThrow(CurrencyMismatchError);
  });

  test('o erro é de domínio, tem code estável e cita as moedas', () => {
    try {
      brl('1.00').add(usd('1.00'));
      throw new Error('deveria lançar');
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      expect((e as CurrencyMismatchError).code).toBe('CURRENCY_MISMATCH');
      expect((e as Error).message).toContain('BRL');
      expect((e as Error).message).toContain('USD');
    }
  });

  test('zero de moedas diferentes também não se combina', () => {
    expect(() => Money.zero('BRL').add(Money.zero('USD'))).toThrow(CurrencyMismatchError);
  });
});

describe('serialização', () => {
  test('toJSON devolve MoneyProps com string decimal (nunca number nem Money)', () => {
    const json = brl('25.00').toJSON();
    expect(typeof json.amount).toBe('string');
    expect(Object.keys(json).sort()).toEqual(['amount', 'currency']);
  });

  test('JSON.stringify usa toJSON', () => {
    expect(JSON.stringify({ money: brl('975.00') })).toBe('{"money":{"amount":"975.00","currency":"BRL"}}');
    expect(JSON.stringify(brl('0.10'))).toBe('{"amount":"0.10","currency":"BRL"}');
  });

  test('ida e volta: from(toJSON()) reproduz o valor', () => {
    for (const amount of ['0.00', '0.01', '25.00', '1000.50', MAX]) {
      const original = brl(amount);
      expect(Money.from(original.toJSON()).equals(original)).toBe(true);
    }
  });

  test('toString legível, sempre com 2 casas e sem notação científica', () => {
    expect(brl('25.00').toString()).toBe('25.00 BRL');
    expect(brl('0.01').toString()).toBe('0.01 BRL');
    expect(brl('0.00').toString()).toBe('0.00 BRL');
    expect(brl(MAX).toString()).toBe(`${MAX} BRL`);
    expect(brl('10.00').negate().toString()).toBe('-10.00 BRL');
  });
});

describe('imutabilidade', () => {
  test('operações devolvem novas instâncias e não alteram os operandos', () => {
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

  test('a instância está congelada: não aceita reatribuição nem novas propriedades', () => {
    const money = brl('10.00');
    expect(Object.isFrozen(money)).toBe(true);
    expect(() => { (money as unknown as { currency: string }).currency = 'USD'; }).toThrow(TypeError);
    expect(() => { (money as unknown as Record<string, unknown>).extra = 1; }).toThrow(TypeError);
    expect(money.currency).toBe('BRL');
    expect(money.toJSON().amount).toBe('10.00');
  });

  test('alterar o objeto devolvido por toJSON não afeta o Money', () => {
    const money = brl('10.00');
    const json = money.toJSON();
    json.amount = '999.00';
    json.currency = 'USD';
    expect(money.toJSON()).toEqual({ amount: '10.00', currency: 'BRL' });
  });

  test('alterar o objeto de entrada depois de from não afeta o Money', () => {
    const props = { amount: '10.00', currency: 'BRL' };
    const money = Money.from(props);
    props.amount = '999.00';
    expect(money.toJSON().amount).toBe('10.00');
  });

  test('o construtor é privado: instanciar direto não é permitido pelo tipo', () => {
    // @ts-expect-error construtor privado: só as factories criam Money
    void new Money(null, 'BRL');
  });
});

describe('propriedades (oráculo em BigInt, independente do decimal.js)', () => {
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

  test('500 pares aleatórios: soma, subtração e comparação batem com o oráculo', () => {
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
