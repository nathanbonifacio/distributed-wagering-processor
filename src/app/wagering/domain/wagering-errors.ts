import { DomainError } from '../../../shared/domain/domain-error';
import { ProgrammingError } from '../../../shared/domain/programming-error';

/** Dados que nunca formam uma transação válida (ex.: REFUND sem referência, OPENING externo). */
export class InvalidWagerTransactionError extends DomainError {
  readonly code = 'INVALID_WAGER_TRANSACTION';
}

/** A mesma chave com outro payload, ou o mesmo id externo com outra chave. Nunca é replay. */
export class IdempotencyConflictError extends DomainError {
  readonly code = 'IDEMPOTENCY_KEY_REUSED';
}

/** Transição não permitida pela máquina de estados. */
export class InvalidTransactionStateError extends ProgrammingError {
  readonly code = 'INVALID_TRANSACTION_STATE';
}

/** O WagerProcessor recebeu objetos incoerentes entre si (ex.: wallet de outra transação). */
export class InvalidWagerOperationError extends ProgrammingError {
  readonly code = 'INVALID_WAGER_OPERATION';
}
