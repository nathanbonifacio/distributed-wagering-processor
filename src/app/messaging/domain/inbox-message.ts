import { DomainError } from '../../../shared/domain/domain-error';

/** O mesmo messageId chegou com outro conteúdo. Não é redelivery: o produtor reutilizou o id. */
export class InboxMessageConflictError extends DomainError {
  readonly code = 'INBOX_MESSAGE_CONFLICT';
}

export interface InboxMessageState {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

/** Entrega de uma mensagem a um consumidor. Protege a entrega; a idempotency key protege a operação. */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: Omit<InboxMessageState, 'processedAt'>): InboxMessage {
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, new Date(props.receivedAt));
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state.messageId, state.consumerName, state.payloadHash, new Date(state.receivedAt), state.processedAt && new Date(state.processedAt));
  }

  get processedAt(): Date | undefined {
    return this._processedAt && new Date(this._processedAt);
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  markProcessed(at: Date): void {
    this._processedAt = new Date(at);
  }
}
