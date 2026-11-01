import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import { runWithContext } from '../application/request-context';

export const CORRELATION_HEADER = 'x-correlation-id';

/** Aceita só um identificador simples: o valor volta na resposta e entra nos logs, então não pode quebrá-los. */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
}
interface HttpResponse {
  setHeader(name: string, value: string): void;
}

/** Dá a cada requisição um correlationId (o do chamador, se válido) e o repete na resposta. */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(request: HttpRequest, response: HttpResponse, next: () => void): void {
    const provided = request.headers[CORRELATION_HEADER];
    const correlationId = typeof provided === 'string' && SAFE_CORRELATION_ID.test(provided) ? provided : randomUUID();
    response.setHeader('X-Correlation-Id', correlationId);
    runWithContext({ correlationId }, next);
  }
}
