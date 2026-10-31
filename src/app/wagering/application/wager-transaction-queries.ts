import type { UnitOfWork } from '../../../shared/application/unit-of-work.port';
import type { WagerTransaction } from '../domain/wager-transaction.entity';
import type { WageringPersistence } from './ports/wagering-persistence.port';

/** Consultas de transação. Só leem; ausente é `undefined`. */
export class WagerTransactionQueries {
  constructor(private readonly unitOfWork: UnitOfWork<WageringPersistence>) {}

  getById(transactionId: string): Promise<WagerTransaction | undefined> {
    return this.unitOfWork.run((persistence) => persistence.transactions.findById(transactionId));
  }

  getByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.unitOfWork.run((persistence) => persistence.transactions.findByExternalId(providerId, externalTransactionId));
  }
}
