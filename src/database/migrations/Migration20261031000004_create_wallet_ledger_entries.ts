import { Migration } from '@mikro-orm/migrations';

export class Migration20261031000004_create_wallet_ledger_entries extends Migration {
  override async up(): Promise<void> {
    this.addSql(`CREATE TABLE wallet_ledger_entries (
      id uuid PRIMARY KEY,
      -- Base do cursor da paginação: só cresce.
      seq bigint GENERATED ALWAYS AS IDENTITY,
      wallet_id uuid NOT NULL REFERENCES wallets (id) ON DELETE RESTRICT,
      transaction_id uuid NOT NULL,
      wallet_version integer NOT NULL,
      direction text NOT NULL,
      amount numeric(20,2) NOT NULL,
      balance_before numeric(20,2) NOT NULL,
      balance_after numeric(20,2) NOT NULL,
      currency char(3) NOT NULL,
      created_at timestamptz NOT NULL,

      -- O lançamento pertence à wallet da própria transação.
      CONSTRAINT ledger_transaction_same_wallet
        FOREIGN KEY (transaction_id, wallet_id)
        REFERENCES wager_transactions (id, wallet_id) ON DELETE RESTRICT,
      -- No máximo um lançamento por transação e wallet: um retry nunca duplica o movimento.
      CONSTRAINT ledger_transaction_wallet_unique UNIQUE (transaction_id, wallet_id),
      -- Cada versão da wallet tem um lançamento: um lost update falha em vez de corromper.
      CONSTRAINT ledger_wallet_version_unique UNIQUE (wallet_id, wallet_version),

      CONSTRAINT ledger_wallet_version_valid CHECK (wallet_version >= 1),
      CONSTRAINT ledger_direction_valid CHECK (direction IN ('DEBIT', 'CREDIT')),
      CONSTRAINT ledger_amount_positive CHECK (amount > 0),
      CONSTRAINT ledger_balances_non_negative CHECK (balance_before >= 0 AND balance_after >= 0),
      CONSTRAINT ledger_arithmetic CHECK (
        (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
        (direction = 'DEBIT' AND balance_after = balance_before - amount)
      ),
      CONSTRAINT ledger_currency_format CHECK (currency ~ '^[A-Z]{3}$')
    )`);

    // Paginação por keyset e reconciliação.
    this.addSql('CREATE INDEX ledger_wallet_seq ON wallet_ledger_entries (wallet_id, seq)');
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE wallet_ledger_entries');
  }
}
