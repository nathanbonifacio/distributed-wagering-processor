/**
 * Falhas fora do domínio, lançadas pelos adaptadores atrás dos ports. Não geram rejeição de negócio.
 * Transitória: a operação não foi decidida e pode ser repetida (retry, sem estado terminal).
 * Permanente: repetir não adianta; a transação termina em FAILED com FailureCode.InternalError.
 */
export abstract class InfrastructureError extends Error {
  abstract readonly retryable: boolean;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class TransientInfrastructureError extends InfrastructureError {
  readonly retryable = true;
}

export class PermanentInfrastructureError extends InfrastructureError {
  readonly retryable = false;
}

/**
 * O banco recusou a escrita por uma constraint ou trigger. `constraint` permite ao use case decidir
 * (ex.: wallet duplicada vira conflito). A mensagem não traz SQL nem valores; o original fica em `cause`.
 */
export class PersistenceConstraintError extends PermanentInfrastructureError {
  constructor(
    readonly constraint: string | undefined,
    options?: ErrorOptions,
  ) {
    super(`restrição do banco violada: ${constraint ?? 'desconhecida'}`, options);
  }
}
