import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Money } from '../../src/shared/domain/money';
import { FailureCode, isRejectionCode } from '../../src/app/wagering/domain/failure-code';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/app/wagering/domain/wager-transaction.entity';
import { LedgerDirection } from '../../src/app/wallet/domain/ledger-entry.entity';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

// Pré-requisito: `docker compose up -d postgres`. Ataca as constraints com SQL direto em um banco descartável.
const NOW = '2026-10-31T12:00:00.000Z';
const HASH = 'a'.repeat(64);

type Row = Record<string, unknown>;
let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await db.orm.migrator.up();
});
afterAll(async () => { await db.drop(); });

async function insert(table: string, row: Row): Promise<void> {
  const columns = Object.keys(row);
  await db.sql(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    Object.values(row),
  );
}

async function wallet(overrides: Row = {}): Promise<Row & { id: string }> {
  const row = {
    id: randomUUID(),
    player_id: randomUUID(),
    currency: 'BRL',
    balance: '100.00',
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
  await insert('wallets', row);
  return row as Row & { id: string };
}

function txRow(walletId: string, overrides: Row = {}): Row & { id: string } {
  const external = randomUUID();
  const row = {
    id: randomUUID(),
    provider_id: 'provider-a',
    external_transaction_id: external,
    idempotency_key: `provider-a:${external}`,
    payload_hash: HASH,
    wallet_id: walletId,
    player_id: randomUUID(),
    round_id: 'round-1',
    game_id: 'fortune-chimp',
    kind: 'BET',
    amount: '25.00',
    currency: 'BRL',
    status: 'PROCESSED',
    observed_balance: '75.00',
    created_at: NOW,
    processed_at: NOW,
    ...overrides,
  };
  // A moeda do saldo observado acompanha o saldo, salvo quando o teste a informa.
  return { observed_balance_currency: row.observed_balance === null || row.observed_balance === undefined ? null : 'BRL', ...row };
}

async function tx(walletId: string, overrides: Row = {}): Promise<Row & { id: string }> {
  const row = txRow(walletId, overrides);
  await insert('wager_transactions', row);
  return row;
}

let nextVersion = 1000;
function ledgerRow(walletId: string, transactionId: string, overrides: Row = {}): Row & { id: string } {
  return {
    id: randomUUID(),
    wallet_id: walletId,
    transaction_id: transactionId,
    wallet_version: nextVersion++,
    direction: 'DEBIT',
    amount: '25.00',
    balance_before: '100.00',
    balance_after: '75.00',
    currency: 'BRL',
    created_at: NOW,
    ...overrides,
  };
}

/** Falha pelo motivo certo: a mensagem do PostgreSQL precisa citar a constraint ou o texto esperado. */
async function expectViolation(action: () => Promise<unknown>, expected: string): Promise<void> {
  let error: unknown;
  try {
    await action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeDefined();
  expect(String((error as Error).message)).toContain(expected);
}

describe('wallets', () => {
  test('a valid row is accepted (the others fail only because of the attacked field)', async () => {
    await wallet();
  });

  test('negative balance', async () => {
    await expectViolation(() => wallet({ balance: '-0.01' }), 'wallets_balance_non_negative');
  });

  test('a zero balance is accepted', async () => {
    await wallet({ balance: '0.00' });
  });

  test('negative balance also by UPDATE', async () => {
    const row = await wallet();
    await expectViolation(() => db.sql('UPDATE wallets SET balance = -1 WHERE id = ?', [row.id]), 'wallets_balance_non_negative');
  });

  test('version lower than 1', async () => {
    await expectViolation(() => wallet({ version: 0 }), 'wallets_version_valid');
  });

  test('currency outside the format', async () => {
    await expectViolation(() => wallet({ currency: 'brl' }), 'wallets_currency_format');
  });

  test('two wallets for the same player and currency; another currency is allowed', async () => {
    const row = await wallet();
    await expectViolation(() => wallet({ player_id: row.player_id }), 'wallets_player_currency_unique');
    await wallet({ player_id: row.player_id, currency: 'USD' });
  });
});

describe('NUMERIC(20,2) and compatibility with Money', () => {
  test.each(['0.00', '0.10', '25.00', '999999999999999999.99'])('%s comes back as an exact string and rehydrates as Money', async (amount) => {
    const row = await wallet({ balance: amount });
    const [read] = await db.sql('SELECT balance, currency FROM wallets WHERE id = ?', [row.id]);
    expect(typeof read?.balance).toBe('string');
    expect(read?.balance).toBe(amount);
    expect(Money.from({ amount: read?.balance, currency: read?.currency }).toJSON()).toEqual({ amount, currency: 'BRL' });
  });

  test('arithmetic in the database is exact: 0.10 + 0.20 = 0.30', async () => {
    const row = await wallet({ balance: '0.10' });
    await db.sql('UPDATE wallets SET balance = balance + 0.20 WHERE id = ?', [row.id]);
    const [read] = await db.sql('SELECT balance FROM wallets WHERE id = ?', [row.id]);
    expect(read?.balance).toBe('0.30');
  });

  test('what Money does not accept for having too many digits, the database also refuses', async () => {
    await expectViolation(() => wallet({ balance: '1000000000000000000.00' }), 'overflow');
  });

  test('known limitation: NUMERIC rounds extra scale, so only Money may write values', async () => {
    const row = await wallet({ balance: '1.005' });
    const [read] = await db.sql('SELECT balance FROM wallets WHERE id = ?', [row.id]);
    expect(read?.balance).toBe('1.01');
  });
});

describe('wager_transactions: uniqueness and idempotency', () => {
  test('same idempotency key', async () => {
    const w = await wallet();
    const first = await tx(w.id);
    await expectViolation(() => tx(w.id, { idempotency_key: first.idempotency_key }), 'wager_tx_idempotency_key_unique');
  });

  test('the same key on another wallet also conflicts (global scope)', async () => {
    const first = await tx((await wallet()).id);
    const other = await wallet();
    await expectViolation(() => tx(other.id, { idempotency_key: first.idempotency_key }), 'wager_tx_idempotency_key_unique');
  });

  test('same external id on the same provider; on another provider it is allowed', async () => {
    const w = await wallet();
    const first = await tx(w.id);
    await expectViolation(() => tx(w.id, { external_transaction_id: first.external_transaction_id }), 'wager_tx_provider_external_unique');
    await tx(w.id, { provider_id: 'provider-b', external_transaction_id: first.external_transaction_id });
  });

  test('payload_hash outside the hexadecimal SHA-256 format', async () => {
    const w = await wallet();
    await expectViolation(() => tx(w.id, { payload_hash: 'z'.repeat(64) }), 'wager_tx_payload_hash_format');
  });
});

describe('wager_transactions: domain values', () => {
  test.each(Object.values(WagerTransactionKind).filter((k) => k !== 'REFUND' && k !== 'ROLLBACK' && k !== 'OPENING'))('domain kind %s is accepted', async (kind) => {
    await tx((await wallet()).id, { kind });
  });

  test('kind e status desconhecidos', async () => {
    const w = await wallet();
    await expectViolation(() => tx(w.id, { kind: 'BONUS' }), 'wager_tx_kind_valid');
    await expectViolation(() => tx(w.id, { status: 'DONE', processed_at: null }), 'wager_tx_status_valid');
  });

  test('every rejection code of the domain is accepted', async () => {
    const w = await wallet();
    for (const code of Object.values(FailureCode).filter(isRejectionCode)) {
      await tx(w.id, { status: WagerTransactionStatus.Rejected, failure_code: code });
    }
  });

  test('FAILED accepts only INTERNAL_ERROR, and REJECTED never accepts it', async () => {
    const w = await wallet();
    await tx(w.id, { status: 'FAILED', failure_code: FailureCode.InternalError, observed_balance: null });
    await expectViolation(() => tx(w.id, { status: 'FAILED', failure_code: 'INSUFFICIENT_FUNDS', observed_balance: null }), 'wager_tx_failed_is_internal');
    await expectViolation(() => tx(w.id, { status: 'REJECTED', failure_code: 'INTERNAL_ERROR' }), 'wager_tx_rejected_not_internal');
  });

  test('unknown code', async () => {
    const w = await wallet();
    await expectViolation(() => tx(w.id, { status: 'REJECTED', failure_code: 'NOPE' }), 'wager_tx_failure_code_valid');
  });

  test('a code is required on a rejection and forbidden outside one', async () => {
    const w = await wallet();
    await expectViolation(() => tx(w.id, { status: 'REJECTED' }), 'wager_tx_failure_code_required');
    await expectViolation(() => tx(w.id, { failure_code: 'INSUFFICIENT_FUNDS' }), 'wager_tx_failure_code_required');
  });

  test('amount: positive for kinds that move balance, zero only on LOSS, never negative', async () => {
    const w = await wallet();
    await expectViolation(() => tx(w.id, { amount: '0.00' }), 'wager_tx_amount_valid');
    await expectViolation(() => tx(w.id, { amount: '-1.00' }), 'wager_tx_amount_valid');
    await expectViolation(() => tx(w.id, { kind: 'LOSS', amount: '-1.00' }), 'wager_tx_amount_valid');
    await tx(w.id, { kind: 'LOSS', amount: '0.00' });
  });

  test('OPENING requires the reserved provider, and the reserved provider only accepts OPENING', async () => {
    const w = await wallet();
    await tx(w.id, { kind: 'OPENING', provider_id: 'internal' });
    await expectViolation(() => tx(w.id, { kind: 'OPENING' }), 'wager_tx_opening_internal');
    await expectViolation(() => tx(w.id, { provider_id: 'internal' }), 'wager_tx_opening_internal');
  });

  test('processed_at exists exactly in terminal states', async () => {
    const w = await wallet();
    await expectViolation(() => tx(w.id, { processed_at: null }), 'wager_tx_processed_at_terminal');
    await expectViolation(() => tx(w.id, { status: 'PENDING', observed_balance: null }), 'wager_tx_processed_at_terminal');
  });

  test('observed balance: required on a decision, absent while pending, never negative', async () => {
    const w = await wallet();
    await expectViolation(() => tx(w.id, { observed_balance: null }), 'wager_tx_observed_balance_decided');
    await expectViolation(() => tx(w.id, { observed_balance: '-1.00' }), 'wager_tx_observed_balance_non_negative');
    await expectViolation(
      () => tx(w.id, { status: 'PENDING', processed_at: null }),
      'wager_tx_observed_balance_undecided',
    );
  });

  test('observed balance currency: follows the balance, has a valid format and may differ from the operation', async () => {
    const w = await wallet();
    await expectViolation(() => tx(w.id, { observed_balance_currency: null }), 'wager_tx_observed_balance_currency_paired');
    await expectViolation(
      () => tx(w.id, { status: 'FAILED', failure_code: 'INTERNAL_ERROR', observed_balance: null, observed_balance_currency: 'BRL' }),
      'wager_tx_observed_balance_currency_paired',
    );
    await expectViolation(() => tx(w.id, { observed_balance_currency: 'brl' }), 'wager_tx_observed_balance_currency_format');
    await tx(w.id, { status: 'REJECTED', failure_code: 'CURRENCY_MISMATCH', currency: 'USD', observed_balance_currency: 'BRL' });
  });

  test('a pending transaction is always scheduled, and only a pending one has a schedule', async () => {
    const w = await wallet();
    const pending = { kind: 'REFUND', reference_external_transaction_id: 'x', status: 'PENDING_REFERENCE', processed_at: null, observed_balance: null };
    await expectViolation(() => tx(w.id, pending), 'wager_tx_pending_scheduled');
    await tx(w.id, { ...pending, next_attempt_at: NOW });
    await expectViolation(() => tx(w.id, { next_attempt_at: NOW }), 'wager_tx_pending_scheduled');
  });

  test('negative attempts', async () => {
    const w = await wallet();
    await expectViolation(() => tx(w.id, { attempts: -1 }), 'wager_tx_attempts_valid');
  });
});

describe('wager_transactions: references', () => {
  test.each(['REFUND', 'ROLLBACK'])('%s requires an external reference', async (kind) => {
    const w = await wallet();
    await expectViolation(() => tx(w.id, { kind, status: 'REJECTED', failure_code: 'AMOUNT_MISMATCH' }), 'wager_tx_reference_required');
  });

  test('BET does not accept a reference; WIN and LOSS do, optionally', async () => {
    const w = await wallet();
    await expectViolation(
      () => tx(w.id, { reference_external_transaction_id: 'x', status: 'REJECTED', failure_code: 'REFERENCE_KIND_INVALID' }),
      'wager_tx_reference_not_accepted',
    );
    const bet = await tx(w.id);
    await tx(w.id, { kind: 'WIN' });
    await tx(w.id, { kind: 'WIN', reference_external_transaction_id: bet.external_transaction_id, reference_transaction_id: bet.id });
    await tx(w.id, { kind: 'LOSS', reference_external_transaction_id: bet.external_transaction_id, reference_transaction_id: bet.id });
  });

  test('a transaction does not reference itself', async () => {
    const w = await wallet();
    const row = txRow(w.id, { kind: 'WIN', status: 'REJECTED', failure_code: 'REFERENCE_KIND_INVALID' });
    await expectViolation(
      () => insert('wager_transactions', { ...row, reference_external_transaction_id: row.external_transaction_id }),
      'wager_tx_reference_not_self',
    );
  });

  test('applied with an external reference must have the internal one; internal requires external', async () => {
    const w = await wallet();
    const bet = await tx(w.id);
    await expectViolation(() => tx(w.id, { kind: 'REFUND', reference_external_transaction_id: 'x' }), 'wager_tx_processed_reference_resolved');
    await expectViolation(
      () => tx(w.id, { kind: 'WIN', reference_transaction_id: bet.id, status: 'REJECTED', failure_code: 'REFERENCE_MISMATCH' }),
      'wager_tx_reference_resolved',
    );
  });

  test('internal reference nonexistent or from another wallet', async () => {
    const w = await wallet();
    const refund = { kind: 'REFUND', reference_external_transaction_id: 'x' };
    await expectViolation(() => tx(w.id, { ...refund, reference_transaction_id: randomUUID() }), 'wager_tx_reference_same_wallet');
    const other = await tx((await wallet()).id);
    await expectViolation(() => tx(w.id, { ...refund, reference_transaction_id: other.id }), 'wager_tx_reference_same_wallet');
  });

  test('an audited rejection may diverge from the player and currency of the wallet', async () => {
    const w = await wallet();
    await tx(w.id, { status: 'REJECTED', failure_code: 'PLAYER_WALLET_MISMATCH', player_id: randomUUID() });
    await tx(w.id, { status: 'REJECTED', failure_code: 'CURRENCY_MISMATCH', currency: 'USD' });
  });

  test('nonexistent wallet', async () => {
    await expectViolation(() => tx(randomUUID()), 'wager_transactions_wallet_id_fkey');
  });
});

describe('reversals', () => {
  const reversal = (kind: string, bet: Row, overrides: Row = {}) => ({
    kind,
    reference_external_transaction_id: bet.external_transaction_id,
    reference_transaction_id: bet.id,
    ...overrides,
  });

  test.each([
    ['REFUND', 'REFUND'],
    ['REFUND', 'ROLLBACK'],
    ['ROLLBACK', 'REFUND'],
    ['ROLLBACK', 'ROLLBACK'],
  ])('%s followed by %s on the same original operation', async (first, second) => {
    const w = await wallet();
    const bet = await tx(w.id);
    await tx(w.id, reversal(first, bet));
    await expectViolation(() => tx(w.id, reversal(second, bet)), 'wager_tx_single_reversal');
  });

  test('rejections do not take the slot: several can exist, and then one applied', async () => {
    const w = await wallet();
    const bet = await tx(w.id);
    const rejected = { status: 'REJECTED', failure_code: 'AMOUNT_MISMATCH' };
    await tx(w.id, reversal('REFUND', bet, rejected));
    await tx(w.id, reversal('ROLLBACK', bet, rejected));
    await tx(w.id, reversal('REFUND', bet));
  });

  test('legitimate README operations are not blocked', async () => {
    const w = await wallet();
    const bet = await tx(w.id);
    // Vários WIN e LOSS referenciando a mesma BET.
    await tx(w.id, reversal('WIN', bet));
    await tx(w.id, reversal('WIN', bet));
    await tx(w.id, reversal('LOSS', bet));
    // REFUND da BET e, depois, ROLLBACK do próprio REFUND.
    const refund = await tx(w.id, reversal('REFUND', bet));
    await tx(w.id, reversal('ROLLBACK', refund));
    // ROLLBACK de um WIN e de uma BET distinta.
    const win = await tx(w.id, { kind: 'WIN' });
    await tx(w.id, reversal('ROLLBACK', win));
    const otherBet = await tx(w.id);
    await tx(w.id, reversal('ROLLBACK', otherBet));
  });
});

describe('wager_transactions: state triggers', () => {
  const pending = (reference = 'x') => ({
    kind: 'REFUND',
    reference_external_transaction_id: reference,
    status: 'PENDING_REFERENCE',
    processed_at: null,
    observed_balance: null,
    next_attempt_at: NOW,
  });

  test.each([
    ['PROCESSED', {}],
    ['REJECTED', { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' }],
    ['FAILED', { status: 'FAILED', failure_code: 'INTERNAL_ERROR', observed_balance: null }],
  ])('%s is neither changed nor deleted', async (_label, overrides) => {
    const row = await tx((await wallet()).id, overrides);
    await expectViolation(() => db.sql(`UPDATE wager_transactions SET attempts = 1 WHERE id = ?`, [row.id]), 'estado terminal');
    await expectViolation(() => db.sql(`DELETE FROM wager_transactions WHERE id = ?`, [row.id]), 'estado terminal');
  });

  test('resumption: PENDING_REFERENCE schedules new attempts and is then decided', async () => {
    const w = await wallet();
    const bet = await tx(w.id);
    const row = await tx(w.id, pending(bet.external_transaction_id as string));
    await db.sql(`UPDATE wager_transactions SET attempts = 1, next_attempt_at = ? WHERE id = ?`, [NOW, row.id]);
    await db.sql(
      `UPDATE wager_transactions
       SET status = 'PROCESSED', processed_at = ?, observed_balance = '100.00', observed_balance_currency = 'BRL',
           next_attempt_at = NULL, reference_transaction_id = ?
       WHERE id = ?`,
      [NOW, bet.id, row.id],
    );
    const [read] = await db.sql('SELECT status, attempts FROM wager_transactions WHERE id = ?', [row.id]);
    expect(read).toEqual({ status: 'PROCESSED', attempts: 1 });
  });

  test('an exhausted PENDING_REFERENCE becomes REJECTED REFERENCE_NOT_FOUND', async () => {
    const row = await tx((await wallet()).id, pending());
    await db.sql(
      `UPDATE wager_transactions
       SET status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND', processed_at = ?, observed_balance = '100.00',
           observed_balance_currency = 'BRL', next_attempt_at = NULL
       WHERE id = ?`,
      [NOW, row.id],
    );
    const [read] = await db.sql('SELECT status, failure_code FROM wager_transactions WHERE id = ?', [row.id]);
    expect(read).toEqual({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND' });
  });

  test('PENDING_REFERENCE does not go back to PENDING', async () => {
    const row = await tx((await wallet()).id, pending());
    await expectViolation(
      () => db.sql(`UPDATE wager_transactions SET status = 'PENDING', next_attempt_at = NULL WHERE id = ?`, [row.id]),
      'transição inválida',
    );
  });

  test.each([
    ['amount', "'26.00'"],
    ['payload_hash', `'${'b'.repeat(64)}'`],
    ['kind', "'ROLLBACK'"],
    ['idempotency_key', "'outra'"],
    ['round_id', "'outra'"],
  ])('the pending operation data is immutable: %s', async (column, value) => {
    const row = await tx((await wallet()).id, pending());
    await expectViolation(() => db.sql(`UPDATE wager_transactions SET ${column} = ${value} WHERE id = ?`, [row.id]), 'são imutáveis');
  });
});

describe('wallet_ledger_entries', () => {
  async function setup() {
    const w = await wallet();
    return { w, t: await tx(w.id) };
  }

  test('coherent DEBIT and CREDIT are accepted; seq grows', async () => {
    const { w, t } = await setup();
    const first = ledgerRow(w.id, t.id);
    await insert('wallet_ledger_entries', first);
    const credit = await tx(w.id, { kind: 'WIN' });
    const second = ledgerRow(w.id, credit.id, { direction: 'CREDIT', balance_before: '75.00', balance_after: '100.00' });
    await insert('wallet_ledger_entries', second);
    const rows = await db.sql('SELECT id, seq FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY seq', [w.id]);
    expect(rows.map((r) => r.id)).toEqual([first.id, second.id]);
  });

  test.each([
    ['DEBIT computed wrong', { balance_after: '75.01' }, 'ledger_arithmetic'],
    ['CREDIT computed wrong', { direction: 'CREDIT', balance_after: '75.00' }, 'ledger_arithmetic'],
    ['zero amount', { amount: '0.00', balance_after: '100.00' }, 'ledger_amount_positive'],
    ['negative amount', { amount: '-25.00', balance_after: '125.00' }, 'ledger_amount_positive'],
    ['negative resulting balance', { amount: '125.00', balance_after: '-25.00' }, 'ledger_balances_non_negative'],
    ['negative previous balance', { direction: 'CREDIT', balance_before: '-5.00', balance_after: '20.00' }, 'ledger_balances_non_negative'],
    // Duas constraints recusam: o PostgreSQL avalia CHECKs em ordem alfabética e reporta a aritmética.
    ['unknown direction', { direction: 'SIDEWAYS' }, 'ledger_arithmetic'],
    ['zero version', { wallet_version: 0 }, 'ledger_wallet_version_valid'],
    ['currency outside the format', { currency: 'brl' }, 'ledger_currency_format'],
  ])('rejects: %s', async (_label, overrides, constraint) => {
    const { w, t } = await setup();
    await expectViolation(() => insert('wallet_ledger_entries', ledgerRow(w.id, t.id, overrides)), constraint);
  });

  test('the domain directions are the accepted ones', async () => {
    const { w, t } = await setup();
    expect(Object.values<string>(LedgerDirection).sort()).toEqual(['CREDIT', 'DEBIT']);
    await insert('wallet_ledger_entries', ledgerRow(w.id, t.id, { direction: LedgerDirection.Debit }));
  });

  test('second entry for the same transaction: a retry does not duplicate the debit', async () => {
    const { w, t } = await setup();
    await insert('wallet_ledger_entries', ledgerRow(w.id, t.id));
    await expectViolation(() => insert('wallet_ledger_entries', ledgerRow(w.id, t.id)), 'ledger_transaction_wallet_unique');
  });

  test('two entries on the same wallet version: a lost update fails', async () => {
    const { w, t } = await setup();
    await insert('wallet_ledger_entries', ledgerRow(w.id, t.id, { wallet_version: 2 }));
    const other = await tx(w.id);
    await expectViolation(() => insert('wallet_ledger_entries', ledgerRow(w.id, other.id, { wallet_version: 2 })), 'ledger_wallet_version_unique');
  });

  test('transaction from another wallet or nonexistent', async () => {
    const { w } = await setup();
    const foreign = await tx((await wallet()).id);
    await expectViolation(() => insert('wallet_ledger_entries', ledgerRow(w.id, foreign.id)), 'ledger_transaction_same_wallet');
    await expectViolation(() => insert('wallet_ledger_entries', ledgerRow(w.id, randomUUID())), 'ledger_transaction_same_wallet');
  });

  test.each([
    ['LOSS', { kind: 'LOSS' }],
    ['REJECTED', { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' }],
    ['FAILED', { status: 'FAILED', failure_code: 'INTERNAL_ERROR', observed_balance: null }],
  ])('%s produces no ledger entry', async (_label, overrides) => {
    const w = await wallet();
    const t = await tx(w.id, overrides);
    await expectViolation(() => insert('wallet_ledger_entries', ledgerRow(w.id, t.id)), 'não pode ter lançamento');
  });

  test('UPDATE, DELETE and TRUNCATE are blocked, even by direct SQL', async () => {
    const { w, t } = await setup();
    const entry = ledgerRow(w.id, t.id);
    await insert('wallet_ledger_entries', entry);
    await expectViolation(() => db.sql(`UPDATE wallet_ledger_entries SET amount = 1 WHERE id = ?`, [entry.id]), 'imutável');
    await expectViolation(() => db.sql(`DELETE FROM wallet_ledger_entries WHERE id = ?`, [entry.id]), 'imutável');
    await expectViolation(() => db.sql('TRUNCATE wallet_ledger_entries'), 'imutável');
    const [read] = await db.sql('SELECT amount FROM wallet_ledger_entries WHERE id = ?', [entry.id]);
    expect(read?.amount).toBe('25.00');
  });

  test('a wallet and a transaction with an entry cannot be deleted', async () => {
    const { w, t } = await setup();
    await insert('wallet_ledger_entries', ledgerRow(w.id, t.id));
    await expectViolation(() => db.sql('DELETE FROM wallets WHERE id = ?', [w.id]), 'foreign key');
  });

  test('seq is generated by the database and cannot be supplied', async () => {
    const { w, t } = await setup();
    await expectViolation(() => insert('wallet_ledger_entries', { ...ledgerRow(w.id, t.id), seq: 1 }), 'seq');
  });
});

describe('inbox_messages', () => {
  const row = (overrides: Row = {}) => ({
    consumer_name: 'wager-consumer',
    message_id: randomUUID(),
    payload_hash: HASH,
    received_at: NOW,
    ...overrides,
  });

  test('same message for the same consumer; another consumer is allowed', async () => {
    const first = row();
    await insert('inbox_messages', first);
    await expectViolation(() => insert('inbox_messages', first), 'inbox_messages_pkey');
    await insert('inbox_messages', { ...first, consumer_name: 'outro' });
  });

  test('ON CONFLICT DO NOTHING allows detecting the duplicate without aborting the transaction', async () => {
    const first = row();
    const statement = `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
      VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING message_id`;
    const params = [first.consumer_name, first.message_id, first.payload_hash, first.received_at];
    expect(await db.sql(statement, params)).toHaveLength(1);
    expect(await db.sql(statement, params)).toHaveLength(0);
  });

  test('hash outside the format', async () => {
    await expectViolation(() => insert('inbox_messages', row({ payload_hash: 'x' })), 'inbox_payload_hash_format');
  });
});

describe('outbox_messages', () => {
  const row = (overrides: Row = {}) => ({
    id: randomUUID(),
    aggregate_id: randomUUID(),
    event_type: 'WalletBalanceChanged',
    payload: JSON.stringify({ eventId: 'e', data: { money: { amount: '25.00', currency: 'BRL' } } }),
    occurred_at: NOW,
    next_attempt_at: NOW,
    ...overrides,
  });

  test('the envelope comes back intact, with the monetary value as a string', async () => {
    const message = row();
    await insert('outbox_messages', message);
    const [read] = await db.sql('SELECT payload, attempts, published_at FROM outbox_messages WHERE id = ?', [message.id]);
    expect(read?.payload.data.money.amount).toBe('25.00');
    expect(read?.attempts).toBe(0);
    expect(read?.published_at).toBeNull();
  });

  test('a payload that is not an object, negative attempts and a missing schedule', async () => {
    await expectViolation(() => insert('outbox_messages', row({ payload: '[]' })), 'outbox_payload_is_object');
    await expectViolation(() => insert('outbox_messages', row({ attempts: -1 })), 'outbox_attempts_valid');
    await expectViolation(() => insert('outbox_messages', row({ next_attempt_at: null })), 'next_attempt_at');
  });
});
