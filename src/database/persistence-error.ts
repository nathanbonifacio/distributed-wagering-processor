import {
  InfrastructureError,
  PersistenceConstraintError,
  TransientInfrastructureError,
} from '../shared/application/infrastructure-error';

/** Lock timeout, statement timeout, deadlock, falha de serialização, servidor reiniciando ou sem conexões livres. */
const TRANSIENT_SQLSTATES = new Set(['40001', '40P01', '55P03', '57014', '57P01', '57P02', '57P03', '53300']);
const TRANSIENT_NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ConnectionRefused']);
/** Erros do driver pg que não trazem `code`. */
const TRANSIENT_DRIVER_MESSAGES = /timeout exceeded when trying to connect|Connection terminated|Query read timeout/i;

interface DriverFailure {
  code?: string;
  constraint?: string;
  message?: string;
}

/**
 * Traduz só o que o use case sabe tratar: constraint (classe 23 do SQLSTATE) e falha transitória.
 * O restante, inclusive erros de domínio e defeitos de programação, segue como está.
 */
export function translatePersistenceError(error: unknown): unknown {
  if (!(error instanceof Error) || error instanceof InfrastructureError) return error;
  const { code, constraint, message } = error as DriverFailure;

  if (code?.startsWith('23')) {
    return new PersistenceConstraintError(constraint, { cause: error });
  }
  const transient =
    (code !== undefined && (TRANSIENT_SQLSTATES.has(code) || TRANSIENT_NETWORK_CODES.has(code) || code.startsWith('08'))) ||
    TRANSIENT_DRIVER_MESSAGES.test(message ?? '');
  if (transient) {
    return new TransientInfrastructureError(`falha transitória de banco (${code ?? 'conexão'})`, { cause: error });
  }
  return error;
}
