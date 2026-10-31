import { z } from 'zod';
import { InvalidMoneyError, Money, type MoneyProps } from '../domain/money';

/** Texto de identificação: sem caracteres de controle, que o PostgreSQL recusaria (ex.: NUL) ou que quebrariam logs. */
export const identifierSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\u0000-\u001f\u007f]+$/, 'não pode conter caracteres de controle');

/** O PostgreSQL guarda uuid em minúsculas; sem normalizar, a mesma entidade divergiria na comparação e no hash. */
export const uuidSchema = z.uuid().transform((value) => value.toLowerCase());

/** Delega a regra a Money.from, para existir um único formato de valor aceito. Nunca há coerção de `number`. */
export const moneySchema = z
  .strictObject({ amount: z.string(), currency: z.string() })
  .superRefine((money: MoneyProps, context) => {
    try {
      Money.from(money);
    } catch (error) {
      if (!(error instanceof InvalidMoneyError)) throw error;
      context.addIssue({ code: 'custom', message: error.message });
    }
  });
