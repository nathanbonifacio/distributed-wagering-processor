import type { Money } from '../../../shared/domain/money';
import { LedgerDirection, type WalletLedgerEntry } from '../../wallet/domain/ledger-entry.entity';
import type { Wallet } from '../../wallet/domain/wallet.entity';
import { FailureCode } from './failure-code';
import { type WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from './wager-transaction.entity';
import { InvalidWagerOperationError } from './wagering-errors';

export interface ProcessWagerInput {
  wallet: Wallet;
  transaction: WagerTransaction;
  /** Transação resolvida por (providerId, referenceExternalTransactionId); ausente se não existe. */
  reference?: WagerTransaction;
  /** Reversão já registrada para a referência, se houver. */
  existingReversal?: WagerTransaction;
  /** Id do lançamento, caso a operação mova saldo. */
  ledgerEntryId: string;
  at: Date;
}

export interface ProcessOpeningInput {
  wallet: Wallet;
  transaction: WagerTransaction;
  ledgerEntryId: string;
  at: Date;
}

export interface WagerApplied {
  outcome: 'APPLIED';
  transaction: WagerTransaction;
  /** Ausente só em LOSS. */
  ledgerEntry?: WalletLedgerEntry;
  balance: Money;
}

export interface WagerRejected {
  outcome: 'REJECTED';
  transaction: WagerTransaction;
  failureCode: FailureCode;
  balance: Money;
}

/** Sem saldo: nada foi decidido, então não há saldo observado a relatar. */
export interface WagerPendingReference {
  outcome: 'PENDING_REFERENCE';
  transaction: WagerTransaction;
}

export type WagerOutcome = WagerApplied | WagerRejected | WagerPendingReference;

/**
 * Sequencia as regras que vivem nas classes e decide tudo antes de alterar a Wallet. Sem estado e sem
 * IO: o lock da wallet, a resolução da referência e a persistência são de quem chama.
 */
export class WagerProcessor {
  process(input: ProcessWagerInput): WagerOutcome {
    const { wallet, transaction, reference, existingReversal, at } = input;
    this.assertProcessable(input);

    const walletFailure = transaction.validateWallet(wallet);
    if (walletFailure) return this.reject(wallet, transaction, walletFailure, at);

    if (transaction.referenceExternalTransactionId !== undefined) {
      if (!reference) return this.awaitReference(transaction);
      const referenceFailure = transaction.validateReference(reference, existingReversal);
      if (referenceFailure) return this.reject(wallet, transaction, referenceFailure, at);
      if (!reference.isTerminal()) return this.awaitReference(transaction);
    }

    if (!transaction.affectsBalance()) {
      return this.apply(wallet, transaction, reference, undefined, at);
    }

    const movement = { entryId: input.ledgerEntryId, transactionId: transaction.id, money: transaction.money, at };
    if (transaction.ledgerDirectionFor(reference) === LedgerDirection.Debit) {
      if (!wallet.canDebit(transaction.money)) {
        return this.reject(wallet, transaction, transaction.insufficientFundsCode(), at);
      }
      return this.apply(wallet, transaction, reference, wallet.debit(movement), at);
    }
    if (!wallet.canCredit(transaction.money)) {
      return this.reject(wallet, transaction, FailureCode.BalanceLimitExceeded, at);
    }
    return this.apply(wallet, transaction, reference, wallet.credit(movement), at);
  }

  /** Abertura: o saldo já está na wallet; registra a transação e o lançamento correspondentes. */
  processOpening(input: ProcessOpeningInput): WagerApplied {
    const { wallet, transaction, ledgerEntryId, at } = input;
    if (transaction.kind !== WagerTransactionKind.Opening) {
      throw new InvalidWagerOperationError(`processOpening não aceita ${transaction.kind}`);
    }
    if (transaction.walletId !== wallet.id || !transaction.money.equals(wallet.balance)) {
      throw new InvalidWagerOperationError('a transação de abertura deve corresponder à wallet e ao saldo inicial');
    }
    const ledgerEntry = wallet.openingEntry({ entryId: ledgerEntryId, transactionId: transaction.id, at });
    return this.apply(wallet, transaction, undefined, ledgerEntry, at);
  }

  /**
   * Limite de tentativas esgotado. A referência ausente é REFERENCE_NOT_FOUND; a que existe, mas segue
   * pendente em uma cadeia de reversões, é REFERENCE_NOT_PROCESSED.
   */
  expireReference(wallet: Wallet, transaction: WagerTransaction, reference: WagerTransaction | undefined, at: Date): WagerRejected {
    const failureCode = reference ? FailureCode.ReferenceNotProcessed : FailureCode.ReferenceNotFound;
    transaction.recordObservedBalance(wallet.balance);
    transaction.expireReference(failureCode, at);
    return { outcome: 'REJECTED', transaction, failureCode, balance: wallet.balance };
  }

  private assertProcessable({ wallet, transaction, reference }: ProcessWagerInput): void {
    if (transaction.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerOperationError('OPENING é processado por processOpening');
    }
    if (transaction.isTerminal()) {
      throw new InvalidWagerOperationError(`transação ${transaction.id} já está em ${transaction.status}`);
    }
    if (transaction.walletId !== wallet.id) {
      throw new InvalidWagerOperationError(`transação ${transaction.id} não pertence à wallet ${wallet.id}`);
    }
    if (reference && reference.externalTransactionId !== transaction.referenceExternalTransactionId) {
      throw new InvalidWagerOperationError(`a referência fornecida não é a pedida por ${transaction.id}`);
    }
  }

  private apply(
    wallet: Wallet,
    transaction: WagerTransaction,
    reference: WagerTransaction | undefined,
    ledgerEntry: WalletLedgerEntry | undefined,
    at: Date,
  ): WagerApplied {
    transaction.recordObservedBalance(wallet.balance);
    transaction.markProcessed(reference?.id, at);
    return { outcome: 'APPLIED', transaction, ledgerEntry, balance: wallet.balance };
  }

  private reject(wallet: Wallet, transaction: WagerTransaction, failureCode: FailureCode, at: Date): WagerRejected {
    transaction.recordObservedBalance(wallet.balance);
    transaction.reject(failureCode, at);
    return { outcome: 'REJECTED', transaction, failureCode, balance: wallet.balance };
  }

  /** Em uma retomada a transação já está pendente e apenas permanece. */
  private awaitReference(transaction: WagerTransaction): WagerPendingReference {
    if (transaction.status === WagerTransactionStatus.Pending) transaction.markPendingReference();
    return { outcome: 'PENDING_REFERENCE', transaction };
  }
}
