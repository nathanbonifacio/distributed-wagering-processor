import { DomainError } from '../../shared/domain/domain-error';
import { ProgrammingError } from '../../shared/domain/programming-error';

/** Débito além do saldo. Regra de negócio; o WagerProcessor a converte em rejeição com failureCode. */
export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
}

export class InvalidWalletError extends ProgrammingError {
  readonly code = 'INVALID_WALLET';
}

export class InvalidLedgerEntryError extends ProgrammingError {
  readonly code = 'INVALID_LEDGER_ENTRY';
}
