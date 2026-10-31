import { Money } from '../../domain/money';

/** Money para coluna NUMERIC(20,2): sempre a string decimal exata, nunca `number`. */
export function moneyToColumn(money: Money): string {
  return money.toJSON().amount;
}

/**
 * Coluna NUMERIC(20,2) para Money. O driver devolve string, e qualquer outra coisa é recusada por
 * Money.from. O sinal é tratado aqui porque Money.from só aceita entrada externa não negativa, e
 * somas calculadas no banco (como o total assinado do ledger) podem ser negativas.
 */
export function moneyFromColumn(amount: string, currency: string): Money {
  return typeof amount === 'string' && amount.startsWith('-')
    ? Money.from({ amount: amount.slice(1), currency }).negate()
    : Money.from({ amount, currency });
}
