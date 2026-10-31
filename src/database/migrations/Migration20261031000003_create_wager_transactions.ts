import { Migration } from '@mikro-orm/migrations';

/**
 * Sem FK de player e moeda para a wallet, de propósito: PLAYER_WALLET_MISMATCH e CURRENCY_MISMATCH
 * são rejeições auditáveis, então essas linhas precisam poder divergir da wallet.
 */
export class Migration20261031000003_create_wager_transactions extends Migration {
  override async up(): Promise<void> {
    this.addSql(`CREATE TABLE wager_transactions (
      id uuid PRIMARY KEY,
      provider_id text NOT NULL,
      external_transaction_id text NOT NULL,
      idempotency_key text NOT NULL,
      payload_hash char(64) NOT NULL,
      wallet_id uuid NOT NULL REFERENCES wallets (id) ON DELETE RESTRICT,
      player_id uuid NOT NULL,
      round_id text NOT NULL,
      game_id text NOT NULL,
      kind text NOT NULL,
      amount numeric(20,2) NOT NULL,
      currency char(3) NOT NULL,
      reference_external_transaction_id text,
      reference_transaction_id uuid,
      status text NOT NULL,
      failure_code text,
      observed_balance numeric(20,2),
      attempts integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz,
      created_at timestamptz NOT NULL,
      processed_at timestamptz,

      CONSTRAINT wager_tx_idempotency_key_unique UNIQUE (idempotency_key),
      -- Também é o índice da resolução de referência.
      CONSTRAINT wager_tx_provider_external_unique UNIQUE (provider_id, external_transaction_id),
      -- Alvo das FKs compostas: referência e lançamento ficam presos à mesma wallet.
      CONSTRAINT wager_tx_id_wallet_unique UNIQUE (id, wallet_id),
      -- A referência aplicada precisa ser da mesma wallet (regra 2 do README).
      CONSTRAINT wager_tx_reference_same_wallet
        FOREIGN KEY (reference_transaction_id, wallet_id)
        REFERENCES wager_transactions (id, wallet_id) ON DELETE RESTRICT,

      CONSTRAINT wager_tx_kind_valid
        CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
      CONSTRAINT wager_tx_status_valid
        CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
      CONSTRAINT wager_tx_failure_code_valid CHECK (failure_code IN (
        'INSUFFICIENT_FUNDS', 'REVERSAL_INSUFFICIENT_FUNDS', 'REFERENCE_NOT_FOUND', 'REFERENCE_NOT_PROCESSED',
        'REFERENCE_KIND_INVALID', 'REFERENCE_MISMATCH', 'AMOUNT_MISMATCH', 'ALREADY_REVERSED',
        'PLAYER_WALLET_MISMATCH', 'CURRENCY_MISMATCH', 'BALANCE_LIMIT_EXCEEDED', 'INTERNAL_ERROR'
      )),
      CONSTRAINT wager_tx_payload_hash_format CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
      CONSTRAINT wager_tx_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
      CONSTRAINT wager_tx_attempts_valid CHECK (attempts >= 0),
      CONSTRAINT wager_tx_observed_balance_non_negative CHECK (observed_balance >= 0),

      -- Só LOSS pode ter valor zero; nenhum kind tem valor negativo.
      CONSTRAINT wager_tx_amount_valid CHECK (amount > 0 OR (kind = 'LOSS' AND amount = 0)),
      -- O provider reservado existe só para OPENING, e OPENING só com ele.
      CONSTRAINT wager_tx_opening_internal CHECK ((kind = 'OPENING') = (provider_id = 'internal')),

      CONSTRAINT wager_tx_reference_required
        CHECK (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
      CONSTRAINT wager_tx_reference_not_accepted
        CHECK (kind NOT IN ('BET', 'OPENING') OR reference_external_transaction_id IS NULL),
      CONSTRAINT wager_tx_reference_not_self CHECK (reference_external_transaction_id <> external_transaction_id),
      CONSTRAINT wager_tx_reference_resolved CHECK (
        reference_transaction_id IS NULL OR reference_external_transaction_id IS NOT NULL
      ),
      -- Aplicada com referência externa precisa ter a referência interna resolvida.
      CONSTRAINT wager_tx_processed_reference_resolved CHECK (
        status <> 'PROCESSED' OR (reference_external_transaction_id IS NULL) = (reference_transaction_id IS NULL)
      ),

      CONSTRAINT wager_tx_failure_code_required
        CHECK ((status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)),
      CONSTRAINT wager_tx_failed_is_internal CHECK (status <> 'FAILED' OR failure_code = 'INTERNAL_ERROR'),
      CONSTRAINT wager_tx_rejected_not_internal CHECK (status <> 'REJECTED' OR failure_code <> 'INTERNAL_ERROR'),
      CONSTRAINT wager_tx_processed_at_terminal
        CHECK ((status IN ('PROCESSED', 'REJECTED', 'FAILED')) = (processed_at IS NOT NULL)),
      -- Regra 7: o replay devolve o saldo da decisão. Pendente não inventa saldo.
      CONSTRAINT wager_tx_observed_balance_decided CHECK (
        status NOT IN ('PROCESSED', 'REJECTED') OR observed_balance IS NOT NULL
      ),
      CONSTRAINT wager_tx_observed_balance_undecided CHECK (
        status NOT IN ('PENDING', 'PENDING_REFERENCE') OR observed_balance IS NULL
      ),
      -- Toda pendente está agendada, e só pendente tem agendamento.
      CONSTRAINT wager_tx_pending_scheduled CHECK ((status = 'PENDING_REFERENCE') = (next_attempt_at IS NOT NULL))
    )`);

    // Uma única reversão financeira por operação original (REFUND ou ROLLBACK), também sob concorrência.
    // Não alcança WIN nem LOSS, e o ROLLBACK de um REFUND tem outra referência: continuam permitidos.
    this.addSql(`CREATE UNIQUE INDEX wager_tx_single_reversal
      ON wager_transactions (reference_transaction_id)
      WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED'`);

    // O retrier encontra as pendentes vencidas sem varrer a tabela.
    this.addSql(`CREATE INDEX wager_tx_pending_due
      ON wager_transactions (next_attempt_at)
      WHERE status = 'PENDING_REFERENCE'`);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE wager_transactions');
  }
}
