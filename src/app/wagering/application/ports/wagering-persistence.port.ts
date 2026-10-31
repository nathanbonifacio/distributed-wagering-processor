import type { InboxRepository } from '../../../messaging/application/ports/inbox.repository.port';
import type { OutboxRepository } from '../../../messaging/application/ports/outbox.repository.port';
import type { WalletPersistence } from '../../../wallet/application/ports/wallet-persistence.port';
import type { WagerTransactionRepository } from './wager-transaction.repository.port';

/** Tudo o que precisa ser atômico no processamento de uma transação, na mesma transação SQL. */
export interface WageringPersistence extends WalletPersistence {
  transactions: WagerTransactionRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}
