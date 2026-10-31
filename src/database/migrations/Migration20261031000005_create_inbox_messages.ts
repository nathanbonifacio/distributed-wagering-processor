import { Migration } from '@mikro-orm/migrations';

export class Migration20261031000005_create_inbox_messages extends Migration {
  override async up(): Promise<void> {
    // A PK deduplica a entrega por consumidor. Sem FK: a mensagem pode não corresponder a nenhuma transação.
    this.addSql(`CREATE TABLE inbox_messages (
      consumer_name text NOT NULL,
      message_id text NOT NULL,
      payload_hash char(64) NOT NULL,
      received_at timestamptz NOT NULL,
      processed_at timestamptz,
      PRIMARY KEY (consumer_name, message_id),
      CONSTRAINT inbox_payload_hash_format CHECK (payload_hash ~ '^[0-9a-f]{64}$')
    )`);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE inbox_messages');
  }
}
