import { Migration } from '@mikro-orm/migrations';

/** O que um CHECK não expressa, porque compara com a linha anterior ou com outra tabela. */
export class Migration20261031000007_create_integrity_triggers extends Migration {
  override async up(): Promise<void> {
    // Ledger imutável, inclusive contra SQL direto (restrição 5 do README).
    this.addSql(`CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries é imutável: % não é permitido', TG_OP
          USING ERRCODE = 'restrict_violation';
      END;
    $$ LANGUAGE plpgsql`);
    this.addSql(`CREATE TRIGGER ledger_immutable_rows
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation()`);
    this.addSql(`CREATE TRIGGER ledger_immutable_truncate
      BEFORE TRUNCATE ON wallet_ledger_entries
      FOR EACH STATEMENT EXECUTE FUNCTION forbid_ledger_mutation()`);

    // LOSS e transações que terminaram sem aplicar nunca têm lançamento.
    this.addSql(`CREATE FUNCTION guard_ledger_insert() RETURNS trigger AS $$
      DECLARE
        tx_kind text;
        tx_status text;
      BEGIN
        SELECT kind, status INTO tx_kind, tx_status FROM wager_transactions WHERE id = NEW.transaction_id;
        IF tx_kind = 'LOSS' OR tx_status IN ('REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'transação % (%, %) não pode ter lançamento', NEW.transaction_id, tx_kind, tx_status
            USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`);
    this.addSql(`CREATE TRIGGER ledger_guard_insert
      BEFORE INSERT ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION guard_ledger_insert()`);

    // Estados terminais não mudam nem somem; o contrato da operação nunca muda; pendente não volta a PENDING.
    this.addSql(`CREATE FUNCTION guard_wager_transaction_change() RETURNS trigger AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'transação % em estado terminal %: % não é permitido', OLD.id, OLD.status, TG_OP
            USING ERRCODE = 'restrict_violation';
        END IF;
        IF TG_OP = 'DELETE' THEN
          RETURN OLD;
        END IF;
        IF OLD.status = 'PENDING_REFERENCE' AND NEW.status = 'PENDING' THEN
          RAISE EXCEPTION 'transição inválida de PENDING_REFERENCE para PENDING'
            USING ERRCODE = 'restrict_violation';
        END IF;
        IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
            NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
            NEW.reference_external_transaction_id, NEW.created_at)
           IS DISTINCT FROM
           (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
            OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
            OLD.reference_external_transaction_id, OLD.created_at) THEN
          RAISE EXCEPTION 'os dados da operação % são imutáveis', OLD.id
            USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`);
    this.addSql(`CREATE TRIGGER wager_tx_guard_change
      BEFORE UPDATE OR DELETE ON wager_transactions
      FOR EACH ROW EXECUTE FUNCTION guard_wager_transaction_change()`);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TRIGGER wager_tx_guard_change ON wager_transactions');
    this.addSql('DROP FUNCTION guard_wager_transaction_change()');
    this.addSql('DROP TRIGGER ledger_guard_insert ON wallet_ledger_entries');
    this.addSql('DROP FUNCTION guard_ledger_insert()');
    this.addSql('DROP TRIGGER ledger_immutable_truncate ON wallet_ledger_entries');
    this.addSql('DROP TRIGGER ledger_immutable_rows ON wallet_ledger_entries');
    this.addSql('DROP FUNCTION forbid_ledger_mutation()');
  }
}
