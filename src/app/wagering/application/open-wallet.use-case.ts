import { outboxRecordOf } from '../../messaging/application/integration-event-outbox';
import { WalletBalanceChanged } from '../../wallet/domain/events/wallet-balance-changed';
import { Wallet } from '../../wallet/domain/wallet.entity';
import { WalletAlreadyExistsError } from '../../wallet/domain/wallet-errors';
import type { Clock } from '../../../shared/application/clock.port';
import type { IdGenerator } from '../../../shared/application/id-generator.port';
import { PersistenceConstraintError } from '../../../shared/application/infrastructure-error';
import type { UnitOfWork } from '../../../shared/application/unit-of-work.port';
import { Money, type MoneyProps } from '../../../shared/domain/money';
import { WagerTransactionProcessed } from '../domain/events/wager-transaction-events';
import type { WagerProcessor } from '../domain/wager-processor';
import { INTERNAL_PROVIDER_ID, WagerTransaction, WagerTransactionKind } from '../domain/wager-transaction.entity';
import type { WageringPersistence } from './ports/wagering-persistence.port';
import { wagerPayloadHash } from './wager-payload-hash';

const WALLET_UNIQUE_CONSTRAINT = 'wallets_player_currency_unique';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId?: string;
}

/**
 * Abre a wallet e, com saldo positivo, grava na mesma transação a OPENING, o lançamento e os eventos.
 * Fica em `wagering` porque cruza os dois agregados e `wagering` já depende de `wallet` (0001, opção A).
 * A duplicidade é decidida pela constraint do banco, que vale também sob concorrência.
 */
export class OpenWallet {
  constructor(
    private readonly unitOfWork: UnitOfWork<WageringPersistence>,
    private readonly processor: WagerProcessor,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: OpenWalletCommand): Promise<Wallet> {
    const initialBalance = Money.from(command.initialBalance);
    const at = this.clock.now();
    const wallet = Wallet.open({ id: this.ids.next(), playerId: command.playerId, initialBalance, at });
    try {
      await this.unitOfWork.run(async (persistence) => {
        await persistence.wallets.insert(wallet);
        if (initialBalance.isPositive()) await this.recordOpening(persistence, wallet, command, at);
      });
    } catch (error) {
      if (error instanceof PersistenceConstraintError && error.constraint === WALLET_UNIQUE_CONSTRAINT) {
        throw new WalletAlreadyExistsError('a wallet already exists for this player and currency');
      }
      throw error;
    }
    return wallet;
  }

  private async recordOpening(
    persistence: WageringPersistence,
    wallet: Wallet,
    command: OpenWalletCommand,
    at: Date,
  ): Promise<void> {
    const transaction = WagerTransaction.createOpening({
      id: this.ids.next(),
      payloadHash: openingHash(wallet),
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: wallet.balance,
      createdAt: at,
    });
    const { ledgerEntry } = this.processor.processOpening({ wallet, transaction, ledgerEntryId: this.ids.next(), at });

    await persistence.transactions.insertIfAbsent(transaction);
    await persistence.ledger.append(ledgerEntry!);

    const context = () => ({ eventId: this.ids.next(), correlationId: command.correlationId ?? transaction.id, occurredAt: at });
    await persistence.outbox.enqueue(outboxRecordOf(WagerTransactionProcessed.from(transaction, context())));
    await persistence.outbox.enqueue(outboxRecordOf(WalletBalanceChanged.from(ledgerEntry!, context())));
  }
}

/** Os mesmos campos determinísticos de WagerTransaction.createOpening. */
function openingHash(wallet: Wallet): string {
  const openingId = `opening:${wallet.id}`;
  return wagerPayloadHash({
    providerId: INTERNAL_PROVIDER_ID,
    externalTransactionId: openingId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: openingId,
    gameId: INTERNAL_PROVIDER_ID,
    kind: WagerTransactionKind.Opening,
    money: wallet.balance,
  });
}
