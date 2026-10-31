import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { IdempotencyConflictError, InvalidWagerTransactionError } from './app/wagering/domain/wagering-errors';
import { WalletAlreadyExistsError, WalletNotFoundError } from './app/wallet/domain/wallet-errors';
import { TransientInfrastructureError } from './shared/application/infrastructure-error';
import { InvalidMoneyError } from './shared/domain/money';

interface ErrorResponse {
  status: number;
  body: object;
  retryAfterSeconds?: number;
}

const INTERNAL_ERROR_BODY = { code: 'INTERNAL_ERROR', message: 'erro interno' };

/** Códigos dos erros que o próprio Nest ou o Express geram (rota inexistente, JSON malformado...). */
const FRAMEWORK_CODES: Readonly<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'INVALID_PAYLOAD',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.METHOD_NOT_ALLOWED]: 'METHOD_NOT_ALLOWED',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'PAYLOAD_TOO_LARGE',
};

/**
 * Um único contrato de erro, `{ code, message }`, para todas as rotas. Mora na raiz porque conhece erros
 * de vários módulos. Mensagens de domínio são seguras; as de infraestrutura e as desconhecidas podem
 * trazer SQL e valores (`cause`), então nunca saem na resposta nem no log.
 */
function toErrorResponse(error: unknown): ErrorResponse {
  if (error instanceof HttpException) return fromHttpException(error);
  if (error instanceof IdempotencyConflictError || error instanceof WalletAlreadyExistsError) {
    return { status: HttpStatus.CONFLICT, body: { code: error.code, message: error.message } };
  }
  if (error instanceof WalletNotFoundError) {
    return { status: HttpStatus.UNPROCESSABLE_ENTITY, body: { code: error.code, message: error.message } };
  }
  if (error instanceof InvalidWagerTransactionError || error instanceof InvalidMoneyError) {
    return { status: HttpStatus.BAD_REQUEST, body: { code: 'INVALID_PAYLOAD', message: error.message } };
  }
  if (error instanceof TransientInfrastructureError) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      body: { code: 'TEMPORARILY_UNAVAILABLE', message: 'indisponível no momento; a requisição pode ser reenviada' },
      retryAfterSeconds: 1,
    };
  }
  return { status: HttpStatus.INTERNAL_SERVER_ERROR, body: INTERNAL_ERROR_BODY };
}

function fromHttpException(error: HttpException): ErrorResponse {
  const status = error.getStatus();
  const response = error.getResponse();
  // Respostas nossas ficam como estão: as de negócio trazem `code`, e o health traz o próprio relatório.
  if (typeof response === 'object' && !('statusCode' in response)) return { status, body: response };
  // A mensagem padrão pode repetir trechos do corpo recebido, como no erro de JSON malformado.
  return { status, body: { code: FRAMEWORK_CODES[status] ?? 'HTTP_ERROR', message: 'requisição não atendida' } };
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const { status, body, retryAfterSeconds } = toErrorResponse(error);
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR && status !== HttpStatus.SERVICE_UNAVAILABLE) {
      this.logger.error(`falha não tratada: ${error instanceof Error ? error.name : typeof error}`);
    }
    const response = host.switchToHttp().getResponse();
    if (retryAfterSeconds !== undefined) response.setHeader('Retry-After', String(retryAfterSeconds));
    response.status(status).json(body);
  }
}
