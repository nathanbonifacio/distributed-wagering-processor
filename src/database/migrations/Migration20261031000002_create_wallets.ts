import { Migration } from '@mikro-orm/migrations';

export class Migration20261031000002_create_wallets extends Migration {
  override async up(): Promise<void> {
    this.addSql(`CREATE TABLE wallets (
      id uuid PRIMARY KEY,
      player_id uuid NOT NULL,
      currency char(3) NOT NULL,
      balance numeric(20,2) NOT NULL,
      version integer NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      CONSTRAINT wallets_player_currency_unique UNIQUE (player_id, currency),
      CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
      CONSTRAINT wallets_version_valid CHECK (version >= 1),
      CONSTRAINT wallets_currency_format CHECK (currency ~ '^[A-Z]{3}$')
    )`);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE wallets');
  }
}
