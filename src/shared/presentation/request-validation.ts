import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';

/** Falha de validação vira 400. Só caminho e mensagem saem na resposta, nunca o valor recebido. */
export function parseRequest<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new BadRequestException({
    code: 'INVALID_PAYLOAD',
    message: 'invalid request',
    issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  });
}
