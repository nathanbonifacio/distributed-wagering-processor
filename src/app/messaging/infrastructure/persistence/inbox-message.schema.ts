import { EntitySchema } from '@mikro-orm/postgresql';

export interface InboxMessageRow {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRow>({
  name: 'InboxMessageRow',
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', fieldName: 'consumer_name', columnType: 'text', primary: true },
    messageId: { type: 'string', fieldName: 'message_id', columnType: 'text', primary: true },
    payloadHash: { type: 'string', fieldName: 'payload_hash', columnType: 'char(64)' },
    receivedAt: { type: 'datetime', fieldName: 'received_at', columnType: 'timestamptz' },
    processedAt: { type: 'datetime', fieldName: 'processed_at', columnType: 'timestamptz', nullable: true },
  },
});
