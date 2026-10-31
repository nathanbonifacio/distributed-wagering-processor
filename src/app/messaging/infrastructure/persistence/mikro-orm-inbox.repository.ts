import type { EntityManager } from '@mikro-orm/postgresql';
import type { InboxRecord, InboxRepository } from '../../application/ports/inbox.repository.port';
import { InboxMessageSchema } from './inbox-message.schema';

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async recordIfNew(record: InboxRecord): Promise<boolean> {
    // ON CONFLICT em vez de capturar o erro: uma violação de unique inutilizaria a transação.
    const rows = await this.em.execute(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
       VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING message_id`,
      [record.consumerName, record.messageId, record.payloadHash, record.receivedAt],
    );
    return rows.length === 1;
  }

  async find(consumerName: string, messageId: string): Promise<InboxRecord | undefined> {
    const row = await this.em.findOne(InboxMessageSchema, { consumerName, messageId }, { disableIdentityMap: true });
    return row ? { ...row, processedAt: row.processedAt ?? undefined } : undefined;
  }

  async markProcessed(consumerName: string, messageId: string, at: Date): Promise<void> {
    await this.em.nativeUpdate(InboxMessageSchema, { consumerName, messageId }, { processedAt: at });
  }
}
