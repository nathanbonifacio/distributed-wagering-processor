/** Registro plano gravado na mesma transação da alteração financeira. */
export interface InboxRecord {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

export interface InboxRepository {
  /** true se a mensagem é nova; false se já existia. Duplicata não aborta a transação. */
  recordIfNew(record: InboxRecord): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxRecord | undefined>;
  markProcessed(consumerName: string, messageId: string, at: Date): Promise<void>;
}
