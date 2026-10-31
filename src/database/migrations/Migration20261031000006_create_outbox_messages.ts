import { Migration } from '@mikro-orm/migrations';

export class Migration20261031000006_create_outbox_messages extends Migration {
  override async up(): Promise<void> {
    // payload em jsonb: guarda o envelope versionado do evento, nunca consultado por colunas.
    this.addSql(`CREATE TABLE outbox_messages (
      id uuid PRIMARY KEY,
      aggregate_id uuid NOT NULL,
      event_type text NOT NULL,
      payload jsonb NOT NULL,
      occurred_at timestamptz NOT NULL,
      attempts integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL,
      published_at timestamptz,
      last_error text,
      CONSTRAINT outbox_attempts_valid CHECK (attempts >= 0),
      CONSTRAINT outbox_payload_is_object CHECK (jsonb_typeof(payload) = 'object')
    )`);

    // O publisher e a métrica de lag só olham o que falta publicar.
    this.addSql(`CREATE INDEX outbox_pending_due
      ON outbox_messages (next_attempt_at)
      WHERE published_at IS NULL`);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE outbox_messages');
  }
}
