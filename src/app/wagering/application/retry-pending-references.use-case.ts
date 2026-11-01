import type { Clock } from '../../../shared/application/clock.port';
import type { UnitOfWork } from '../../../shared/application/unit-of-work.port';
import type { WageringPersistence } from './ports/wagering-persistence.port';
import type { ProcessWagerTransaction } from './process-wager-transaction.use-case';

export interface RetryPendingReferencesResult {
  claimed: number;
  failed: number;
  /** Nome de cada erro: a mensagem pode trazer SQL. */
  failures: string[];
}

/**
 * Uma transação SQL por operação, e nenhuma aberta entre elas. A consulta não trava nada: duas instâncias
 * podem escolher a mesma linha, e quem chegar depois ao lock da wallet a encontra já decidida ou reagendada.
 * Uma falha não conta como tentativa nem impede o resto do lote.
 */
export class RetryPendingReferences {
  constructor(
    private readonly unitOfWork: UnitOfWork<WageringPersistence>,
    private readonly processWager: ProcessWagerTransaction,
    private readonly clock: Clock,
    private readonly batchSize: number,
  ) {}

  async execute(shouldStop: () => boolean = () => false): Promise<RetryPendingReferencesResult> {
    const now = this.clock.now();
    const ids = await this.unitOfWork.run((persistence) => persistence.transactions.findDuePendingIds(now, this.batchSize));
    const failures: string[] = [];
    for (const id of ids) {
      if (shouldStop()) break;
      try {
        await this.processWager.resumePending(id);
      } catch (error) {
        failures.push(error instanceof Error ? error.name : typeof error);
      }
    }
    return { claimed: ids.length, failed: failures.length, failures };
  }
}
