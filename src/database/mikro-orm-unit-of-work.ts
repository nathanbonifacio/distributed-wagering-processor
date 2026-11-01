import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { TransientInfrastructureError, type TransientReason } from '../shared/application/infrastructure-error';
import type { UnitOfWork } from '../shared/application/unit-of-work.port';
import { translatePersistenceError } from './persistence-error';

/**
 * Cada `run` usa um EntityManager próprio, em uma transação própria. Nada é compartilhado entre
 * operações concorrentes, e os repositórios do contexto escrevem todos na mesma transação.
 */
export class MikroOrmUnitOfWork<TContext> implements UnitOfWork<TContext> {
  constructor(
    private readonly orm: MikroORM,
    private readonly createContext: (em: EntityManager) => TContext,
    private readonly lockTimeoutMs: number,
    /** Chamado quando uma transação falha por disputa de lock (timeout ou deadlock). Nunca altera o erro. */
    private readonly onConcurrencyFailure?: (reason: TransientReason) => void,
  ) {}

  async run<T>(work: (context: TContext) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        // SET não aceita parâmetro; o valor é um inteiro validado na configuração.
        await em.execute(`SET LOCAL lock_timeout = ${Math.trunc(this.lockTimeoutMs)}`);
        return work(this.createContext(em));
      });
    } catch (error) {
      const translated = translatePersistenceError(error);
      if (translated instanceof TransientInfrastructureError && translated.reason) this.onConcurrencyFailure?.(translated.reason);
      throw translated;
    }
  }
}
