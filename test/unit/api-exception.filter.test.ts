import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ArgumentsHost, BadRequestException, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ApiExceptionFilter } from '../../src/api-exception.filter';
import { IdempotencyConflictError, InvalidWagerTransactionError } from '../../src/app/wagering/domain/wagering-errors';
import { InvalidWagerOperationError } from '../../src/app/wagering/domain/wagering-errors';
import { WalletAlreadyExistsError, WalletNotFoundError } from '../../src/app/wallet/domain/wallet-errors';
import {
  PermanentInfrastructureError,
  PersistenceConstraintError,
  TransientInfrastructureError,
} from '../../src/shared/application/infrastructure-error';
import { InvalidMoneyError } from '../../src/shared/domain/money';

const SECRET_SQL = 'insert into wallets values (senha-secreta)';

function handle(error: unknown) {
  const reply = { status: 0, body: undefined as any, headers: {} as Record<string, string> };
  const response = {
    setHeader: (name: string, value: string) => { reply.headers[name] = value; },
    status(code: number) { reply.status = code; return this; },
    json(body: unknown) { reply.body = body; },
  };
  new ApiExceptionFilter().catch(error, { switchToHttp: () => ({ getResponse: () => response }) } as unknown as ArgumentsHost);
  return reply;
}

let logged: string[];

beforeAll(() => {
  logged = [];
  Logger.overrideLogger({
    log() {},
    warn() {},
    error: (message: unknown) => { logged.push(String(message)); },
  });
});
afterAll(() => { Logger.overrideLogger(false); });

describe('ApiExceptionFilter', () => {
  test.each<[string, Error, number, string]>([
    ['conflito de idempotência', new IdempotencyConflictError('x'), 409, 'IDEMPOTENCY_KEY_REUSED'],
    ['wallet duplicada', new WalletAlreadyExistsError('x'), 409, 'WALLET_ALREADY_EXISTS'],
    ['wallet inexistente na submissão', new WalletNotFoundError('x'), 422, 'WALLET_NOT_FOUND'],
    ['transação inválida', new InvalidWagerTransactionError('x'), 400, 'INVALID_PAYLOAD'],
    ['valor inválido', new InvalidMoneyError('x'), 400, 'INVALID_PAYLOAD'],
    ['transitório', new TransientInfrastructureError('x'), 503, 'TEMPORARILY_UNAVAILABLE'],
    ['permanente', new PermanentInfrastructureError('x'), 500, 'INTERNAL_ERROR'],
    ['defeito de programação', new InvalidWagerOperationError('x'), 500, 'INTERNAL_ERROR'],
    ['erro desconhecido', new Error('x'), 500, 'INTERNAL_ERROR'],
  ])('%s', (_name, error, status, code) => {
    const reply = handle(error);
    expect(reply.status).toBe(status);
    expect(reply.body.code).toBe(code);
    expect('stack' in reply.body).toBe(false);
  });

  test('só o transitório traz Retry-After', () => {
    expect(handle(new TransientInfrastructureError('x')).headers['Retry-After']).toBe('1');
    expect(handle(new PermanentInfrastructureError('x')).headers['Retry-After']).toBeUndefined();
  });

  test.each<[string, Error]>([
    ['erro desconhecido', new Error(SECRET_SQL)],
    ['constraint com a causa do driver', new PersistenceConstraintError('c', { cause: new Error(SECRET_SQL) })],
    ['permanente', new PermanentInfrastructureError(SECRET_SQL)],
    ['transitório', new TransientInfrastructureError(SECRET_SQL)],
  ])('nem a resposta nem o log repetem a mensagem interna: %s', (_name, error) => {
    logged.length = 0;
    const reply = handle(error);
    expect(JSON.stringify(reply.body)).not.toContain('senha-secreta');
    expect(logged.join(' ')).not.toContain('senha-secreta');
  });

  test('falha não tratada é registrada, mas transitório e erro de negócio não', () => {
    logged.length = 0;
    handle(new TransientInfrastructureError('x'));
    handle(new IdempotencyConflictError('x'));
    expect(logged).toEqual([]);
    handle(new Error('x'));
    expect(logged).toHaveLength(1);
  });

  test('erro do framework ganha o contrato comum e não repete o corpo recebido', () => {
    const reply = handle(new BadRequestException('Unexpected token: {"cartao":"123"'));
    expect(reply.status).toBe(400);
    expect(reply.body.code).toBe('INVALID_PAYLOAD');
    expect(JSON.stringify(reply.body)).not.toContain('cartao');
  });

  test('resposta já estruturada passa como está: negócio e relatório do health', () => {
    expect(handle(new NotFoundException({ code: 'WALLET_NOT_FOUND', message: 'm' })).body).toEqual({ code: 'WALLET_NOT_FOUND', message: 'm' });
    const report = { status: 'degraded', checks: {} };
    const reply = handle(new ServiceUnavailableException(report));
    expect(reply.status).toBe(503);
    expect(reply.body).toEqual(report);
  });
});
