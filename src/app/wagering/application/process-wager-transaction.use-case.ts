import { outboxRecordOf } from '../../messaging/application/integration-event-outbox';
import type { EventContext, IntegrationEvent } from '../../messaging/domain/integration-event';
import { InboxMessage, InboxMessageConflictError } from '../../messaging/domain/inbox-message';
import { WalletBalanceChanged } from '../../wallet/domain/events/wallet-balance-changed';
import type { Wallet } from '../../wallet/domain/wallet.entity';
import { WalletNotFoundError } from '../../wallet/domain/wallet-errors';
import type { Clock } from '../../../shared/application/clock.port';
import type { IdGenerator } from '../../../shared/application/id-generator.port';
import {
  PermanentInfrastructureError,
  TransientInfrastructureError,
} from '../../../shared/application/infrastructure-error';
import type { UnitOfWork } from '../../../shared/application/unit-of-work.port';
import { Money, type MoneyProps } from '../../../shared/domain/money';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../domain/events/wager-transaction-events';
import { FailureCode } from '../domain/failure-code';
import { ReferenceRetryPolicy } from '../domain/reference-retry-policy';
import type { WagerOutcome, WagerProcessor } from '../domain/wager-processor';
import { WagerTransaction, type WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction.entity';
import { IdempotencyConflictError } from '../domain/wagering-errors';
import type { WageringPersistence } from './ports/wagering-persistence.port';
import { wagerPayloadHash } from './wager-payload-hash';

/** Mesma entrada para HTTP e SQS; validar o formato dos campos é do adaptador. */
export interface ProcessWagerCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId?: string;
  causationId?: string;
}

type EventTrace = Pick<ProcessWagerCommand, 'correlationId' | 'causationId'>;

/** Entrega pela fila: o inbox entra na mesma transação da operação. */
export interface MessageDelivery {
  consumerName: string;
  messageId: string;
}

export interface ProcessWagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Saldo observado na decisão. Ausente enquanto não houver decisão. */
  balance?: Money;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

/**
 * Processa uma operação do provedor em uma única transação SQL. A ordem é a garantia:
 *
 * 1. trava a wallet: duplicatas e disputas pelo saldo passam uma de cada vez, em qualquer instância;
 * 2. procura a operação: replay ou conflito, antes de qualquer efeito;
 * 3. decide sobre o saldo lido sob o lock;
 * 4. insere a transação já no estado final, e só depois grava saldo, ledger e eventos.
 *
 * Decisões de negócio são resultados e confirmam a transação. Erros desfazem tudo e seguem para o
 * adaptador, que escolhe entre 409, retry e DLQ.
 */
export class ProcessWagerTransaction {
  constructor(
    private readonly unitOfWork: UnitOfWork<WageringPersistence>,
    private readonly processor: WagerProcessor,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly referenceRetry: ReferenceRetryPolicy = ReferenceRetryPolicy.DEFAULT,
  ) {}

  async execute(command: ProcessWagerCommand, delivery?: MessageDelivery): Promise<ProcessWagerResult> {
    const transaction = this.newTransaction(command);
    try {
      return await this.unitOfWork.run(async (persistence) => {
        const inbox = delivery && (await this.registerDelivery(persistence, delivery, transaction.payloadHash));
        const result = await this.process(persistence, transaction, command);
        if (inbox) await this.completeDelivery(persistence, inbox);
        return result;
      });
    } catch (error) {
      if (error instanceof PermanentInfrastructureError) await this.recordFailure(command);
      throw error;
    }
  }

  /**
   * Nova tentativa de uma PENDING_REFERENCE vencida, sobre a mesma linha e com as mesmas regras. Devolve
   * undefined se não havia nada a fazer: outra instância chegou antes ou a tentativa foi reagendada.
   */
  async resumePending(transactionId: string): Promise<ProcessWagerResult | undefined> {
    try {
      return await this.unitOfWork.run((persistence) => this.resume(persistence, transactionId));
    } catch (error) {
      if (error instanceof PermanentInfrastructureError) await this.recordResumeFailure(transactionId);
      throw error;
    }
  }

  /** Mesma ordem de lock do fluxo normal: wallet, depois a linha. Sob os dois locks, a decisão é única. */
  private async resume(persistence: WageringPersistence, transactionId: string): Promise<ProcessWagerResult | undefined> {
    const found = await persistence.transactions.findById(transactionId);
    if (!found) return undefined;
    const wallet = await persistence.wallets.findByIdForUpdate(found.walletId);
    const transaction = await persistence.transactions.findByIdForUpdate(transactionId);
    const at = this.clock.now();
    if (!wallet || !transaction?.isReferenceRetryDue(at)) return undefined;

    const versionBefore = wallet.version;
    const references = await this.loadReference(persistence, transaction);
    let outcome = this.processor.process({ wallet, transaction, ...references, ledgerEntryId: this.ids.next(), at });
    if (outcome.outcome === 'PENDING_REFERENCE') {
      const attemptsMade = transaction.attempts + 1;
      if (!this.referenceRetry.isExhausted(attemptsMade)) {
        // Sem evento: WagerTransactionPendingReference marca só a entrada em pendência.
        transaction.scheduleReferenceRetry(this.referenceRetry.nextAttemptAt(attemptsMade, at));
        await persistence.transactions.update(transaction);
        return resultOf(transaction, false);
      }
      outcome = this.processor.expireReference(wallet, transaction, references.reference, at);
    }

    // A linha muda antes do ledger: o trigger do lançamento confere o estado da transação.
    await persistence.transactions.update(transaction);
    await this.persistEffects(persistence, wallet, versionBefore, outcome);
    await this.enqueueEvents(persistence, outcome, {}, at);
    return resultOf(transaction, false);
  }

  /** Equivalente a recordFailure para a linha que já existe. Nunca conta como tentativa de referência. */
  private async recordResumeFailure(transactionId: string): Promise<void> {
    try {
      await this.unitOfWork.run(async (persistence) => {
        const found = await persistence.transactions.findById(transactionId);
        if (!found) return;
        await persistence.wallets.findByIdForUpdate(found.walletId);
        const transaction = await persistence.transactions.findByIdForUpdate(transactionId);
        if (transaction?.status !== WagerTransactionStatus.PendingReference) return;
        transaction.fail(FailureCode.InternalError, this.clock.now());
        await persistence.transactions.update(transaction);
      });
    } catch {
      // O chamador recebe o erro original, e a linha continua pendente para a próxima rodada.
    }
  }

  /**
   * Antes do lock da wallet, sempre nesta ordem: quem espera por um messageId não segura nenhuma wallet, e
   * não há ciclo de espera. Devolve a mensagem só se ainda faltar concluí-la. Uma redelivery segue pelo
   * fluxo normal, que encontra a operação e vira replay, sem efeito.
   */
  private async registerDelivery(
    persistence: WageringPersistence,
    delivery: MessageDelivery,
    payloadHash: string,
  ): Promise<InboxMessage | undefined> {
    const message = InboxMessage.receive({ ...delivery, payloadHash, receivedAt: this.clock.now() });
    if (await persistence.inbox.recordIfNew(message)) return message;

    const existing = InboxMessage.rehydrate((await persistence.inbox.find(delivery.consumerName, delivery.messageId))!);
    if (!existing.matchesPayload(payloadHash)) {
      throw new InboxMessageConflictError(`message ${delivery.messageId} was already received with a different payload`);
    }
    return existing.isProcessed() ? undefined : existing;
  }

  private async completeDelivery(persistence: WageringPersistence, message: InboxMessage): Promise<void> {
    message.markProcessed(this.clock.now());
    await persistence.inbox.markProcessed(message.consumerName, message.messageId, message.processedAt!);
  }

  private async process(
    persistence: WageringPersistence,
    transaction: WagerTransaction,
    command: ProcessWagerCommand,
  ): Promise<ProcessWagerResult> {
    const wallet = await persistence.wallets.findByIdForUpdate(transaction.walletId);

    // Antes do WALLET_NOT_FOUND: uma chave existente com payload divergente é conflito mesmo que a
    // wallet informada não exista.
    const existing = await this.findExisting(persistence, transaction);
    if (existing) return existing;
    if (!wallet) throw new WalletNotFoundError(`wallet ${transaction.walletId} não existe`);

    const versionBefore = wallet.version;
    const at = this.clock.now();
    const outcome = this.processor.process({
      wallet,
      transaction,
      ...(await this.loadReference(persistence, transaction)),
      ledgerEntryId: this.ids.next(),
      at,
    });
    if (outcome.outcome === 'PENDING_REFERENCE') {
      transaction.scheduleReferenceRetry(this.referenceRetry.nextAttemptAt(0, at));
    }

    // A mesma chave em outra wallet não é serializada pelo lock. Aqui a unique decide, e nada foi
    // gravado ainda: a linha da outra operação já está confirmada e define o resultado.
    if (!(await persistence.transactions.insertIfAbsent(transaction))) {
      const winner = await this.findExisting(persistence, transaction);
      if (winner) return winner;
      throw new TransientInfrastructureError(`transação ${transaction.id} colidiu em uma chave única`);
    }

    await this.persistEffects(persistence, wallet, versionBefore, outcome);
    await this.enqueueEvents(persistence, outcome, command, at);
    return resultOf(transaction, false);
  }

  /** Mesma chave e mesmo payload é replay. Outro payload, ou o mesmo id externo com outra chave, é conflito. */
  private async findExisting(
    persistence: WageringPersistence,
    transaction: WagerTransaction,
  ): Promise<ProcessWagerResult | undefined> {
    const byKey = await persistence.transactions.findByIdempotencyKey(transaction.idempotencyKey);
    if (byKey) {
      if (byKey.matchesPayload(transaction.payloadHash)) return resultOf(byKey, true);
      throw new IdempotencyConflictError('a Idempotency-Key já foi usada com outro payload');
    }
    const byExternalId = await persistence.transactions.findByExternalId(
      transaction.providerId,
      transaction.externalTransactionId,
    );
    if (byExternalId) throw new IdempotencyConflictError('o externalTransactionId já foi usado com outra Idempotency-Key');
    return undefined;
  }

  /** Só no mesmo provider: uma referência que exista apenas em outro provider conta como ausente. */
  private async loadReference(
    persistence: WageringPersistence,
    transaction: WagerTransaction,
  ): Promise<{ reference?: WagerTransaction; existingReversal?: WagerTransaction }> {
    if (transaction.referenceExternalTransactionId === undefined) return {};
    const reference = await persistence.transactions.findByExternalId(
      transaction.providerId,
      transaction.referenceExternalTransactionId,
    );
    if (!reference || !transaction.requiresReference()) return { reference };
    return { reference, existingReversal: await persistence.transactions.findAppliedReversal(reference.id) };
  }

  private async persistEffects(
    persistence: WageringPersistence,
    wallet: Wallet,
    versionBefore: number,
    outcome: WagerOutcome,
  ): Promise<void> {
    if (outcome.outcome !== 'APPLIED' || !outcome.ledgerEntry) return;
    await persistence.wallets.update(wallet, versionBefore);
    await persistence.ledger.append(outcome.ledgerEntry);
  }

  private async enqueueEvents(
    persistence: WageringPersistence,
    outcome: WagerOutcome,
    trace: EventTrace,
    at: Date,
  ): Promise<void> {
    for (const event of this.eventsOf(outcome, trace, at)) {
      await persistence.outbox.enqueue(outboxRecordOf(event));
    }
  }

  private eventsOf(outcome: WagerOutcome, trace: EventTrace, at: Date): IntegrationEvent<unknown>[] {
    const { transaction } = outcome;
    const context = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: trace.correlationId ?? transaction.id,
      causationId: trace.causationId,
      occurredAt: at,
    });
    switch (outcome.outcome) {
      case 'APPLIED':
        return [
          WagerTransactionProcessed.from(transaction, context()),
          ...(outcome.ledgerEntry ? [WalletBalanceChanged.from(outcome.ledgerEntry, context())] : []),
        ];
      case 'REJECTED':
        return [WagerTransactionRejected.from(transaction, context())];
      case 'PENDING_REFERENCE':
        return [WagerTransactionPendingReference.from(transaction, context())];
    }
  }

  /**
   * Erro permanente de uma transação válida: registra FAILED, auditável, em uma transação nova, já que
   * a original foi desfeita. Não move saldo. Se o registro falhar, prevalece o erro original.
   */
  private async recordFailure(command: ProcessWagerCommand): Promise<void> {
    const transaction = this.newTransaction(command);
    transaction.fail(FailureCode.InternalError, this.clock.now());
    try {
      await this.unitOfWork.run(async (persistence) => {
        await persistence.wallets.findByIdForUpdate(transaction.walletId);
        await persistence.transactions.insertIfAbsent(transaction);
      });
    } catch {
      // O chamador recebe o erro original, que é o que explica a falha.
    }
  }

  /** OPENING e o provider reservado são recusados aqui, antes de abrir a transação SQL. */
  private newTransaction(command: ProcessWagerCommand): WagerTransaction {
    const money = Money.from(command.money);
    return WagerTransaction.create({
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: wagerPayloadHash({ ...command, money }),
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: this.clock.now(),
    });
  }
}

function resultOf(transaction: WagerTransaction, idempotentReplay: boolean): ProcessWagerResult {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    balance: transaction.observedBalance,
    failureCode: transaction.failureCode,
    idempotentReplay,
  };
}
