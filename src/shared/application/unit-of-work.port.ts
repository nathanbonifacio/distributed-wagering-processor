/**
 * Executa `work` em uma única transação de banco: confirma se ele termina, desfaz se ele lança.
 * `TContext` são os repositórios ligados a essa transação; nada é compartilhado entre execuções.
 */
export interface UnitOfWork<TContext> {
  run<T>(work: (context: TContext) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
