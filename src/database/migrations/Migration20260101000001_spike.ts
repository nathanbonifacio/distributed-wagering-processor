import { Migration } from '@mikro-orm/migrations';

export class Migration20260101000001_spike extends Migration {
  override async up(): Promise<void> {
    this.addSql(`CREATE TABLE spike_wallets (
      id uuid PRIMARY KEY,
      balance numeric(20,2) NOT NULL CHECK (balance >= 0),
      version integer NOT NULL CHECK (version >= 1)
    )`);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE spike_wallets');
  }
}
