import { Migration } from '@mikro-orm/migrations';

/**
 * O saldo observado é da wallet, e a moeda dela pode diferir da moeda da operação (CURRENCY_MISMATCH).
 * Sem esta coluna, o replay devolveria o saldo na moeda errada. A moeda da wallet não muda, então o
 * backfill é exato; o trigger é desligado só nele, porque linhas terminais não aceitam UPDATE.
 */
export class Migration20261031000008_add_observed_balance_currency extends Migration {
  override async up(): Promise<void> {
    this.addSql('ALTER TABLE wager_transactions ADD COLUMN observed_balance_currency char(3)');
    this.addSql('ALTER TABLE wager_transactions DISABLE TRIGGER wager_tx_guard_change');
    this.addSql(`UPDATE wager_transactions t SET observed_balance_currency = w.currency
      FROM wallets w WHERE w.id = t.wallet_id AND t.observed_balance IS NOT NULL`);
    this.addSql('ALTER TABLE wager_transactions ENABLE TRIGGER wager_tx_guard_change');
    this.addSql(`ALTER TABLE wager_transactions
      ADD CONSTRAINT wager_tx_observed_balance_currency_paired
        CHECK ((observed_balance IS NULL) = (observed_balance_currency IS NULL)),
      ADD CONSTRAINT wager_tx_observed_balance_currency_format
        CHECK (observed_balance_currency ~ '^[A-Z]{3}$')`);
  }

  override async down(): Promise<void> {
    this.addSql('ALTER TABLE wager_transactions DROP COLUMN observed_balance_currency');
  }
}
