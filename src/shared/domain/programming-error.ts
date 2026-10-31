import { DomainError } from './domain-error';

/**
 * O código violou um contrato do domínio (ex.: transicionar um estado terminal).
 * Nunca é caminho de negócio: não vira failureCode nem rejeição para o provedor.
 */
export abstract class ProgrammingError extends DomainError {}
