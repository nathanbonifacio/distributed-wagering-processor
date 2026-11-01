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
    ['idempotency conflict', new IdempotencyConflictError('x'), 409, 'IDEMPOTENCY_KEY_REUSED'],
    ['duplicate wallet', new WalletAlreadyExistsError('x'), 409, 'WALLET_ALREADY_EXISTS'],
    ['nonexistent wallet on submission', new WalletNotFoundError('x'), 422, 'WALLET_NOT_FOUND'],
    ['invalid transaction', new InvalidWagerTransactionError('x'), 400, 'INVALID_PAYLOAD'],
    ['invalid amount', new InvalidMoneyError('x'), 400, 'INVALID_PAYLOAD'],
    ['transient', new TransientInfrastructureError('x'), 503, 'TEMPORARILY_UNAVAILABLE'],
    ['permanent', new PermanentInfrastructureError('x'), 500, 'INTERNAL_ERROR'],
    ['programming defect', new InvalidWagerOperationError('x'), 500, 'INTERNAL_ERROR'],
    ['unknown error', new Error('x'), 500, 'INTERNAL_ERROR'],
  ])('%s', (_name, error, status, code) => {
    const reply = handle(error);
    expect(reply.status).toBe(status);
    expect(reply.body.code).toBe(code);
    expect('stack' in reply.body).toBe(false);
  });

  test('only the transient error carries Retry-After', () => {
    expect(handle(new TransientInfrastructureError('x')).headers['Retry-After']).toBe('1');
    expect(handle(new PermanentInfrastructureError('x')).headers['Retry-After']).toBeUndefined();
  });

  test.each<[string, Error]>([
    ['unknown error', new Error(SECRET_SQL)],
    ['constraint with the driver cause', new PersistenceConstraintError('c', { cause: new Error(SECRET_SQL) })],
    ['permanent', new PermanentInfrastructureError(SECRET_SQL)],
    ['transient', new TransientInfrastructureError(SECRET_SQL)],
  ])('neither the response nor the log repeats the internal message: %s', (_name, error) => {
    logged.length = 0;
    const reply = handle(error);
    expect(JSON.stringify(reply.body)).not.toContain('senha-secreta');
    expect(logged.join(' ')).not.toContain('senha-secreta');
  });

  test('an unhandled failure is logged, but a transient or business error is not', () => {
    logged.length = 0;
    handle(new TransientInfrastructureError('x'));
    handle(new IdempotencyConflictError('x'));
    expect(logged).toEqual([]);
    handle(new Error('x'));
    expect(logged).toHaveLength(1);
  });

  test('a framework error gets the common contract and does not echo the received body', () => {
    const reply = handle(new BadRequestException('Unexpected token: {"cartao":"123"'));
    expect(reply.status).toBe(400);
    expect(reply.body.code).toBe('INVALID_PAYLOAD');
    expect(JSON.stringify(reply.body)).not.toContain('cartao');
  });

  test('an already structured response passes through as is: business and health report', () => {
    expect(handle(new NotFoundException({ code: 'WALLET_NOT_FOUND', message: 'm' })).body).toEqual({ code: 'WALLET_NOT_FOUND', message: 'm' });
    const report = { status: 'degraded', checks: {} };
    const reply = handle(new ServiceUnavailableException(report));
    expect(reply.status).toBe(503);
    expect(reply.body).toEqual(report);
  });
});
