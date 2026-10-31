import { Migration } from '@mikro-orm/migrations';

/** A migration do spike já foi aplicada e fica no histórico; a tabela dela sai aqui. */
export class Migration20261031000001_drop_spike_wallets extends Migration {
  override async up(): Promise<void> {
    this.addSql('DROP TABLE spike_wallets');
  }

  override async down(): Promise<void> {
    this.addSql(`CREATE TABLE spike_wallets (
      id uuid PRIMARY KEY,
      balance numeric(20,2) NOT NULL CHECK (balance >= 0),
      version integer NOT NULL CHECK (version >= 1)
    )`);
  }
}
