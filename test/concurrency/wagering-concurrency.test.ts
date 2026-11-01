import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { WagerTransaction, WagerTransactionKind } from '../../src/app/wagering/domain/wager-transaction.entity';
import { wagerPayloadHash } from '../../src/app/wagering/application/wager-payload-hash';
import { WagerProcessor } from '../../src/app/wagering/domain/wager-processor';
import { Wallet } from '../../src/app/wallet/domain/wallet.entity';
import { createPersistenceContext, PERSISTENCE_SCHEMAS } from '../../src/persistence.module';
import { Money } from '../../src/shared/domain/money';
import {
  type ApiCluster,
  countBlockedSessions,
  holdWalletLock,
  type Reply,
  startApiCluster,
  waitForBlockedSessions,
} from '../support/api-cluster';
import { assertFinancialInvariants, movementsOf } from '../support/financial-invariants';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

// Pré-requisito: `docker compose up -d postgres localstack`. PostgreSQL real, migrations reais e banco
// descartável; nenhum mock de banco. Três instâncias independentes da API real concorrem por HTTP.
//
// Dois modos de provocar sobreposição, nenhum deles escolhe quem vence:
// - barreira: outra sessão segura a wallet, os pedidos chegam até o lock (confirmado em pg_stat_activity)
//   e só então a wallet é solta;
// - corrida livre: os pedidos saem juntos, repetidos por várias rodadas, sem coordenação nenhuma.
// As asserções leem o estado no banco e valem para qualquer ordem de serialização.
const ROUNDS = 20;
const TIMEOUT = 60_000;

let db: TestDatabase;
let api: ApiCluster;

beforeAll(async () => {
  db = await createTestDatabase({ entities: PERSISTENCE_SCHEMAS });
  await db.orm.migrator.up();
  api = await startApiCluster(db, 3);
});
afterAll(async () => {
  await api.close();
  await db.drop();
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

type OpenedWallet = { id: string; playerId: string };

async function openWallet(amount = '100.00'): Promise<OpenedWallet> {
  const reply = await api.call('POST', '/wallets', { playerId: randomUUID(), initialBalance: brl(amount) });
  expect(reply.status).toBe(201);
  return reply.body;
}

function payload(wallet: OpenedWallet, kind: string, overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl('25.00'),
    ...overrides,
  };
}

const submit = (body: any, key = `${body.providerId}:${body.externalTransactionId}`, instance?: number) =>
  api.call('POST', '/wagering/transactions', body, { 'Idempotency-Key': key }, instance);

const walletRow = async (id: string) =>
  (await db.sql<{ balance: string; version: number }>('SELECT balance::text AS balance, version FROM wallets WHERE id = ?', [id]))[0]!;

const transactionsOf = (id: string) =>
  db.sql<any>(`SELECT * , amount::text AS amount, observed_balance::text AS observed_balance FROM wager_transactions WHERE wallet_id = ? AND kind <> 'OPENING'`, [id]);

const eventsOf = async (id: string) =>
  (await db.sql<{ event_type: string }>(`SELECT event_type FROM outbox_messages WHERE payload->'data'->>'walletId' = ? ORDER BY event_type`, [id])).map((e) => e.event_type);

const statuses = (replies: Reply[]) => replies.map((r) => r.status).sort();
const expectNoServerError = (replies: Reply[]) => { for (const r of replies) expect(r.status).toBeLessThan(500); };

/** Dispara com a wallet presa, confirma que ao menos `blocked` sessões chegaram ao lock e só então solta. */
async function underBarrier(wallet: OpenedWallet, requests: () => Array<Promise<Reply>>, blocked: number): Promise<Reply[]> {
  const lock = await holdWalletLock(db, wallet.id);
  const pending = requests();
  try {
    expect(await waitForBlockedSessions(db, blocked)).toBeGreaterThanOrEqual(blocked);
  } finally {
    await lock.release();
  }
  return Promise.all(pending);
}

describe('README seção 8: duas BETs de 80.00 sobre 100.00', () => {
  async function assertScenario(wallet: OpenedWallet, replies: Reply[], bets: any[]) {
    expect(statuses(replies)).toEqual([201, 422]);
    expect(replies.find((r) => r.status === 422)!.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: brl('20.00') });
    expect(replies.find((r) => r.status === 201)!.body).toMatchObject({ status: 'PROCESSED', balance: brl('20.00') });

    expect(await walletRow(wallet.id)).toEqual({ balance: '20.00', version: 2 });
    const rows = await transactionsOf(wallet.id);
    expect(rows.map((r: any) => r.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(rows.find((r: any) => r.status === 'REJECTED').failure_code).toBe('INSUFFICIENT_FUNDS');
    const movements = await movementsOf(db, wallet.id);
    expect(movements).toHaveLength(1);
    expect(movements[0]!.direction).toBe('DEBIT');
    expect(movements[0]!.transaction_id).toBe(rows.find((r: any) => r.status === 'PROCESSED').id);
    await assertFinancialInvariants(db, wallet.id);

    // Nenhum retry duplica o débito (última linha do cenário obrigatório).
    const retries = await Promise.all(bets.flatMap((bet) => [submit(bet), submit(bet)]));
    expectNoServerError(retries);
    expect(await walletRow(wallet.id)).toEqual({ balance: '20.00', version: 2 });
    expect(await movementsOf(db, wallet.id)).toHaveLength(1);
  }

  test(`corrida livre, ${ROUNDS} rodadas`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const wallet = await openWallet();
      const bets = [payload(wallet, 'BET', { money: brl('80.00') }), payload(wallet, 'BET', { money: brl('80.00') })];
      await assertScenario(wallet, await Promise.all(bets.map((bet) => submit(bet))), bets);
    }
  }, TIMEOUT);

  test('com as duas sessões comprovadamente disputando o lock', async () => {
    for (let round = 0; round < 5; round++) {
      const wallet = await openWallet();
      const bets = [payload(wallet, 'BET', { money: brl('80.00') }), payload(wallet, 'BET', { money: brl('80.00') })];
      await assertScenario(wallet, await underBarrier(wallet, () => bets.map((bet) => submit(bet)), 2), bets);
    }
  }, TIMEOUT);
});

describe('README seção 13.1: a mesma aposta 50 vezes', () => {
  async function assertSingleEffect(wallet: OpenedWallet, bet: any, replies: Reply[]) {
    expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
    expect(replies.filter((r) => r.status === 200)).toHaveLength(49);
    expect(new Set(replies.map((r) => r.body.transactionId)).size).toBe(1);
    expect(new Set(replies.map((r) => r.body.balance.amount))).toEqual(new Set(['75.00']));
    expect(replies.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);

    const rows = await db.sql<{ n: number }>('SELECT count(*)::int AS n FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?', [bet.providerId, bet.externalTransactionId]);
    expect(rows[0]!.n).toBe(1);
    expect(await walletRow(wallet.id)).toEqual({ balance: '75.00', version: 2 });
    expect(await movementsOf(db, wallet.id)).toHaveLength(1);
    expect((await eventsOf(wallet.id)).filter((type) => type === 'WalletBalanceChanged')).toHaveLength(2); // OPENING e a BET
    await assertFinancialInvariants(db, wallet.id);
  }

  test('corrida livre em 3 instâncias, 5 rodadas', async () => {
    for (let round = 0; round < 5; round++) {
      const wallet = await openWallet();
      const bet = payload(wallet, 'BET');
      await assertSingleEffect(wallet, bet, await Promise.all(Array.from({ length: 50 }, () => submit(bet))));
    }
  }, TIMEOUT);

  test('com dezenas de sessões presas no lock ao mesmo tempo, e o replay preserva o saldo depois', async () => {
    const wallet = await openWallet();
    const bet = payload(wallet, 'BET');
    // 3 instâncias com 10 conexões cada: ao menos 25 das 50 chegam juntas ao lock.
    await assertSingleEffect(wallet, bet, await underBarrier(wallet, () => Array.from({ length: 50 }, () => submit(bet)), 25));

    expect((await submit(payload(wallet, 'WIN', { money: brl('500.00') }))).status).toBe(201);
    const replay = await submit(bet);
    expect(replay.status).toBe(200);
    expect(replay.body.balance).toEqual(brl('75.00'));
    expect((await walletRow(wallet.id)).balance).toBe('575.00');
  }, TIMEOUT);
});

describe('mesma chave com payload divergente', () => {
  /** O vencedor depende de quem pega o lock; o que não depende é a contagem e o estado. */
  async function assertConflictOutcome(key: string, groupA: Reply[], groupB: Reply[]) {
    const [winners, losers] = groupA.some((r) => r.status === 201) ? [groupA, groupB] : [groupB, groupA];
    expect(statuses(winners)).toEqual([...Array(winners.length - 1).fill(200), 201]);
    for (const loser of losers) {
      expect(loser.status).toBe(409);
      expect(loser.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(loser.body.idempotentReplay).toBeUndefined();
    }
    const rows = await db.sql<{ id: string }>('SELECT id FROM wager_transactions WHERE idempotency_key = ?', [key]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(winners[0]!.body.transactionId);
    return winners === groupA ? 'A' : 'B';
  }

  test('mesma wallet, sob barreira: um único payload vence, e o saldo é o dele', async () => {
    for (let round = 0; round < 8; round++) {
      const wallet = await openWallet();
      const a = payload(wallet, 'BET', { money: brl('10.00') });
      const b = { ...a, money: brl('30.00') };
      const key = randomUUID();
      const replies = await underBarrier(
        wallet,
        () => Array.from({ length: 10 }, (_, i) => submit(i % 2 === 0 ? a : b, key)),
        5,
      );
      const winner = await assertConflictOutcome(key, replies.filter((_, i) => i % 2 === 0), replies.filter((_, i) => i % 2 === 1));
      expect(await walletRow(wallet.id)).toEqual({ balance: winner === 'A' ? '90.00' : '70.00', version: 2 });
      expect(await movementsOf(db, wallet.id)).toHaveLength(1);
      await assertFinancialInvariants(db, wallet.id);
    }
  }, TIMEOUT);

  test(`wallets diferentes, onde o lock não serializa e a UNIQUE decide, ${ROUNDS} rodadas`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const [walletA, walletB] = [await openWallet(), await openWallet()];
      const key = randomUUID();
      const a = payload(walletA, 'BET');
      const b = payload(walletB, 'BET');
      const [replyA, replyB] = await Promise.all([submit(a, key), submit(b, key)]);
      expect(statuses([replyA!, replyB!])).toEqual([201, 409]);
      const [winner, loser] = replyA!.status === 201 ? [walletA, walletB] : [walletB, walletA];
      expect(await walletRow(winner.id)).toEqual({ balance: '75.00', version: 2 });
      expect(await walletRow(loser.id)).toEqual({ balance: '100.00', version: 1 });
      expect(await transactionsOf(loser.id)).toHaveLength(0);
      expect(await eventsOf(loser.id)).toHaveLength(2); // só os da abertura
      await assertFinancialInvariants(db, walletA.id);
      await assertFinancialInvariants(db, walletB.id);
    }
  }, TIMEOUT);

  test('mesmo id externo com chaves diferentes: um vence, o resto é conflito', async () => {
    const wallet = await openWallet();
    const bet = payload(wallet, 'BET');
    const replies = await underBarrier(wallet, () => Array.from({ length: 6 }, (_, i) => submit(bet, `chave-${bet.externalTransactionId}-${i}`)), 3);
    expect(statuses(replies)).toEqual([201, 409, 409, 409, 409, 409]);
    expect(await movementsOf(db, wallet.id)).toHaveLength(1);
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);
});

describe('abertura de wallet', () => {
  test(`abertura duplicada em paralelo, ${ROUNDS} rodadas: a constraint decide, com um 201 e o resto 409`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const playerId = randomUUID();
      const replies = await Promise.all(
        Array.from({ length: 8 }, () => api.call('POST', '/wallets', { playerId, initialBalance: brl('10.00') })),
      );
      expect(statuses(replies)).toEqual([201, ...Array(7).fill(409)]);
      for (const reply of replies.filter((r) => r.status === 409)) expect(reply.body.code).toBe('WALLET_ALREADY_EXISTS');
      const [row] = await db.sql<{ n: number }>('SELECT count(*)::int AS n FROM wallets WHERE player_id = ?', [playerId]);
      expect(row!.n).toBe(1);
      await assertFinancialInvariants(db, replies.find((r) => r.status === 201)!.body.id);
    }
  }, TIMEOUT);
});

describe('wallets diferentes', () => {
  test('o bloqueio de uma wallet não impede outra, mesmo com a primeira ainda bloqueada', async () => {
    const [held, free] = [await openWallet(), await openWallet()];
    const lock = await holdWalletLock(db, held.id);
    let heldFinished = false;
    const stuck = Array.from({ length: 3 }, () => submit(payload(held, 'BET')).then((reply) => { heldFinished = true; return reply; }));
    await waitForBlockedSessions(db, 3);

    // Mesmas instâncias, com o pool ainda com folga. Enquanto isso a primeira wallet segue presa.
    for (let i = 0; i < 6; i++) expect((await submit(payload(free, 'WIN', { money: brl('1.00') }), undefined, i % 3)).status).toBe(201);
    expect(heldFinished).toBe(false);
    expect(await countBlockedSessions(db)).toBe(3);
    expect(await walletRow(held.id)).toEqual({ balance: '100.00', version: 1 });
    expect(await walletRow(free.id)).toEqual({ balance: '106.00', version: 7 });

    await lock.release();
    expect(statuses(await Promise.all(stuck))).toEqual([201, 201, 201]);
    expect(await walletRow(held.id)).toEqual({ balance: '25.00', version: 4 });
    await assertFinancialInvariants(db, held.id);
    await assertFinancialInvariants(db, free.id);
  }, TIMEOUT);

  test('pool de uma instância esgotado por uma wallet: outra instância segue, e a mesma espera sem errar', async () => {
    const [hot, otherInstance, samePool] = [await openWallet(), await openWallet(), await openWallet()];
    const lock = await holdWalletLock(db, hot.id);
    const stuck = Array.from({ length: 15 }, () => submit(payload(hot, 'BET', { money: brl('1.00') }), undefined, 0));
    await waitForBlockedSessions(db, 10);

    expect((await submit(payload(otherInstance, 'BET'), undefined, 1)).status).toBe(201);

    // Limitação medida: esta wallet não está presa, mas a instância 0 não tem conexão livre.
    let samePoolFinished = false;
    const queued = submit(payload(samePool, 'BET'), undefined, 0).then((reply) => { samePoolFinished = true; return reply; });
    await Bun.sleep(100);
    expect(samePoolFinished).toBe(false);

    await lock.release();
    expect((await queued).status).toBe(201);
    expect(statuses(await Promise.all(stuck))).toEqual(Array(15).fill(201));
    for (const wallet of [hot, otherInstance, samePool]) await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);

  test('muitas wallets em paralelo: ledgers independentes e saldos corretos', async () => {
    const wallets = await Promise.all(Array.from({ length: 12 }, () => openWallet('100.00')));
    const requests = wallets.flatMap((wallet, index) => [
      submit(payload(wallet, 'BET', { money: brl(`${index + 1}.00`) })),
      submit(payload(wallet, 'WIN', { money: brl('2.00') })),
      submit(payload(wallet, 'LOSS')),
      submit(payload(wallet, 'BET', { money: brl('1.00') })),
    ]);
    expect(new Set(statuses(await Promise.all(requests)))).toEqual(new Set([201]));
    for (const [index, wallet] of wallets.entries()) {
      expect(await walletRow(wallet.id)).toEqual({ balance: `${100 - (index + 1) + 2 - 1}.00`, version: 4 });
      const ids = await db.sql<{ wallet_id: string }>(
        `SELECT DISTINCT t.wallet_id FROM wallet_ledger_entries l JOIN wager_transactions t ON t.id = l.transaction_id WHERE l.wallet_id = ?`,
        [wallet.id],
      );
      expect(ids.map((r) => r.wallet_id)).toEqual([wallet.id]);
      await assertFinancialInvariants(db, wallet.id);
    }
  }, TIMEOUT);
});

describe('operações distintas na mesma wallet', () => {
  test(`BET, WIN e LOSS em qualquer ordem, ${ROUNDS} rodadas: o estado bate com o que foi aplicado`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const wallet = await openWallet('30.00');
      const commands = [
        ...Array.from({ length: 8 }, () => payload(wallet, 'BET', { money: brl('10.00') })),
        ...Array.from({ length: 3 }, () => payload(wallet, 'WIN', { money: brl('5.00') })),
        ...Array.from({ length: 3 }, () => payload(wallet, 'LOSS', { money: brl('10.00') })),
      ];
      const replies = await Promise.all(commands.map((command) => submit(command)));
      expectNoServerError(replies);

      const rows = await transactionsOf(wallet.id);
      expect(rows).toHaveLength(commands.length);
      const processed = (kind: string) => rows.filter((r: any) => r.kind === kind && r.status === 'PROCESSED').length;
      // A BET só é rejeitada por saldo; quantas passam depende da ordem, e por isso nada é fixado aqui.
      for (const row of rows.filter((r: any) => r.status === 'REJECTED')) {
        expect(row.kind).toBe('BET');
        expect(row.failure_code).toBe('INSUFFICIENT_FUNDS');
      }
      expect(processed('WIN')).toBe(3);
      expect(processed('LOSS')).toBe(3);
      const bets = processed('BET');
      expect(bets).toBeGreaterThanOrEqual(3);
      expect(bets).toBeLessThanOrEqual(4);
      const balance = Money.from(brl('30.00')).subtract(Money.from(brl(`${bets * 10}.00`))).add(Money.from(brl('15.00')));
      expect(await walletRow(wallet.id)).toEqual({ balance: balance.toJSON().amount, version: 1 + bets + 3 });
      const movements = await movementsOf(db, wallet.id);
      expect(movements).toHaveLength(bets + 3);
      expect(movements.filter((m) => m.kind === 'LOSS')).toHaveLength(0);
      await assertFinancialInvariants(db, wallet.id);
    }
  }, TIMEOUT);

  test('somente LOSS em paralelo não muda versão nem cria lançamento', async () => {
    const wallet = await openWallet();
    const replies = await underBarrier(wallet, () => Array.from({ length: 8 }, () => submit(payload(wallet, 'LOSS'))), 4);
    expect(new Set(statuses(replies))).toEqual(new Set([201]));
    expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 1 });
    expect(await movementsOf(db, wallet.id)).toHaveLength(0);
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);

  test('o saldo é lido depois do lock: um débito confirmado durante a espera decide a próxima BET', async () => {
    const wallet = await openWallet();
    const at = new Date();
    const lock = await holdWalletLock(db, wallet.id, async (em) => {
      // Sessão à parte, com o código real de persistência, debita 50.00 antes de soltar o lock.
      const persistence = createPersistenceContext(em);
      const locked: Wallet = (await persistence.wallets.findByIdForUpdate(wallet.id))!;
      const money = Money.from(brl('50.00'));
      const earlier = WagerTransaction.create({
        id: randomUUID(),
        providerId: 'provider-a',
        externalTransactionId: `held-${wallet.id}`,
        idempotencyKey: `held-${wallet.id}`,
        payloadHash: wagerPayloadHash({ providerId: 'provider-a', externalTransactionId: `held-${wallet.id}`, playerId: wallet.playerId, walletId: wallet.id, roundId: 'round-1', gameId: 'g', kind: WagerTransactionKind.Bet, money }),
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: 'round-1',
        gameId: 'g',
        kind: WagerTransactionKind.Bet,
        money,
        createdAt: at,
      });
      const outcome = new WagerProcessor().process({ wallet: locked, transaction: earlier, ledgerEntryId: randomUUID(), at });
      if (outcome.outcome !== 'APPLIED') throw new Error('o débito de preparação deveria ser aplicado');
      await persistence.transactions.insertIfAbsent(earlier);
      await persistence.wallets.update(locked, 1);
      await persistence.ledger.append(outcome.ledgerEntry!);
    });
    const pending = submit(payload(wallet, 'BET', { money: brl('80.00') }));
    await waitForBlockedSessions(db, 1);
    await lock.release();

    // Lida antes do lock, a wallet ainda teria 100.00, e esta BET deixaria o saldo em -30.00.
    const reply = await pending;
    expect(reply.status).toBe(422);
    expect(reply.body).toMatchObject({ failureCode: 'INSUFFICIENT_FUNDS', balance: brl('50.00') });
    expect(await walletRow(wallet.id)).toEqual({ balance: '50.00', version: 2 });
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);
});

describe('REFUND e ROLLBACK concorrentes', () => {
  // Interpretação adicional: REFUND e ROLLBACK da mesma operação são mutuamente exclusivos. É mais
  // estrito que a regra 4 do README (que só proíbe repetir o tipo) e impede crédito duplicado.
  test(`REFUND e ROLLBACK da mesma BET, ${ROUNDS} rodadas: uma só reversão, com o valor integral`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const wallet = await openWallet();
      const bet = payload(wallet, 'BET');
      await submit(bet);
      const reference = { referenceExternalTransactionId: bet.externalTransactionId };
      const replies = await Promise.all([
        submit(payload(wallet, 'REFUND', reference)),
        submit(payload(wallet, 'ROLLBACK', reference)),
        submit(payload(wallet, 'REFUND', reference)),
        submit(payload(wallet, 'ROLLBACK', reference)),
      ]);
      expect(statuses(replies)).toEqual([201, 422, 422, 422]);
      for (const reply of replies.filter((r) => r.status === 422)) expect(reply.body.failureCode).toBe('ALREADY_REVERSED');
      expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 3 });
      const reversals = await db.sql<{ n: number }>(`SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = ? AND kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`, [wallet.id]);
      expect(reversals[0]!.n).toBe(1);
      await assertFinancialInvariants(db, wallet.id);
    }
  }, TIMEOUT);

  test('reversões disputando o lock, e a mesma reversão repetida vira replay', async () => {
    const wallet = await openWallet();
    const bet = payload(wallet, 'BET');
    await submit(bet);
    const refund = payload(wallet, 'REFUND', { referenceExternalTransactionId: bet.externalTransactionId });
    const replies = await underBarrier(wallet, () => Array.from({ length: 12 }, () => submit(refund)), 6);
    expect(statuses(replies)).toEqual([...Array(11).fill(200), 201]);
    expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 3 });
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);

  test('ROLLBACK de WIN disputando o saldo com uma BET: cada ordem tem o próprio código, e nunca negativo', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const wallet = await openWallet('0.00');
      const win = payload(wallet, 'WIN', { money: brl('50.00') });
      await submit(win);
      const [bet, rollback] = await Promise.all([
        submit(payload(wallet, 'BET', { money: brl('50.00') })),
        submit(payload(wallet, 'ROLLBACK', { money: brl('50.00'), referenceExternalTransactionId: win.externalTransactionId })),
      ]);
      expect(statuses([bet!, rollback!])).toEqual([201, 422]);
      const rejected = bet!.status === 422 ? bet! : rollback!;
      expect(rejected.body.failureCode).toBe(bet!.status === 422 ? 'INSUFFICIENT_FUNDS' : 'REVERSAL_INSUFFICIENT_FUNDS');
      expect(await walletRow(wallet.id)).toEqual({ balance: '0.00', version: 3 });
      await assertFinancialInvariants(db, wallet.id);
    }
  }, TIMEOUT);

  test('reversões inválidas ao lado de uma válida: só a válida move saldo', async () => {
    const wallet = await openWallet();
    const other = await openWallet();
    const bet = payload(wallet, 'BET');
    await submit(bet);
    const reference = { referenceExternalTransactionId: bet.externalTransactionId };
    const [valid, wrongRound, wrongAmount, wrongWallet, wrongProvider] = await Promise.all([
      submit(payload(wallet, 'REFUND', reference)),
      submit(payload(wallet, 'ROLLBACK', { ...reference, roundId: 'outra' })),
      submit(payload(wallet, 'ROLLBACK', { ...reference, money: brl('10.00') })),
      submit(payload(other, 'REFUND', reference)),
      submit(payload(wallet, 'REFUND', { ...reference, providerId: 'provider-b' })),
    ]);
    expect(valid!.status).toBe(201);
    expect(wrongRound!.body.failureCode).toBe('REFERENCE_MISMATCH');
    expect(wrongAmount!.body.failureCode).toBe('AMOUNT_MISMATCH');
    expect(wrongWallet!.body.failureCode).toBe('REFERENCE_MISMATCH');
    expect(wrongProvider!.status).toBe(202); // no outro provider, a referência não existe
    expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 3 });
    expect(await walletRow(other.id)).toEqual({ balance: '100.00', version: 1 });
    await assertFinancialInvariants(db, wallet.id);
    await assertFinancialInvariants(db, other.id);
  }, TIMEOUT);

  test('a mesma reversão não duplica crédito com a BET e o ROLLBACK do REFUND em paralelo', async () => {
    const wallet = await openWallet();
    const bet = payload(wallet, 'BET');
    await submit(bet);
    const refund = payload(wallet, 'REFUND', { referenceExternalTransactionId: bet.externalTransactionId });
    await submit(refund);
    const undo = { referenceExternalTransactionId: refund.externalTransactionId };
    const replies = await Promise.all(Array.from({ length: 4 }, () => submit(payload(wallet, 'ROLLBACK', undo))));
    expect(statuses(replies)).toEqual([201, 422, 422, 422]);
    expect(await walletRow(wallet.id)).toEqual({ balance: '75.00', version: 4 });
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);
});

describe('README seção 13.7: referência fora de ordem (sem o retrier, que é da Etapa 10)', () => {
  test('reversão antes da referência: pendente, sem movimento, e com o necessário para reprocessar', async () => {
    const wallet = await openWallet();
    const betId = randomUUID();
    const refund = payload(wallet, 'REFUND', { referenceExternalTransactionId: betId });
    const reply = await submit(refund);
    expect(reply.status).toBe(202);
    expect(reply.body.balance).toBeUndefined();

    const [row] = await transactionsOf(wallet.id);
    expect(row).toMatchObject({
      status: 'PENDING_REFERENCE',
      provider_id: 'provider-a',
      external_transaction_id: refund.externalTransactionId,
      reference_external_transaction_id: betId,
      reference_transaction_id: null,
      kind: 'REFUND',
      amount: '25.00',
      currency: 'BRL',
      attempts: 0,
      observed_balance: null,
      failure_code: null,
      processed_at: null,
    });
    expect(Number.isNaN(new Date(row.next_attempt_at).getTime())).toBe(false);
    expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 1 });
    expect(await movementsOf(db, wallet.id)).toHaveLength(0);
    expect((await eventsOf(wallet.id)).filter((t) => t === 'WagerTransactionPendingReference')).toHaveLength(1);
    await assertFinancialInvariants(db, wallet.id);
  });

  test('a mesma pendente em paralelo: uma linha, um evento, e replays sem saldo', async () => {
    const wallet = await openWallet();
    const rollback = payload(wallet, 'ROLLBACK', { referenceExternalTransactionId: 'nao-chegou' });
    const replies = await underBarrier(wallet, () => Array.from({ length: 10 }, () => submit(rollback)), 5);
    expect(new Set(statuses(replies))).toEqual(new Set([202]));
    expect(replies.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
    expect(await transactionsOf(wallet.id)).toHaveLength(1);
    expect((await eventsOf(wallet.id)).filter((t) => t === 'WagerTransactionPendingReference')).toHaveLength(1);
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);

  test(`reversão e referência chegando juntas, ${ROUNDS} rodadas: as duas ordens são válidas e nenhuma duplica`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const wallet = await openWallet();
      const betId = randomUUID();
      const [refund, bet] = await Promise.all([
        submit(payload(wallet, 'REFUND', { referenceExternalTransactionId: betId })),
        submit(payload(wallet, 'BET', { externalTransactionId: betId })),
      ]);
      expect(bet!.status).toBe(201);
      if (refund!.status === 201) {
        expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 3 });
      } else {
        // Sem o retrier a pendente fica como está; a chegada tardia completa é da Etapa 10.
        expect(refund!.status).toBe(202);
        expect(await walletRow(wallet.id)).toEqual({ balance: '75.00', version: 2 });
      }
      await assertFinancialInvariants(db, wallet.id);
    }
  }, TIMEOUT);
});

describe('atomicidade com falhas reais dentro da transação SQL', () => {
  // A falha é um trigger criado só neste banco descartável e restrito a uma wallet: o PostgreSQL recusa
  // o comando no meio da transação, sem nenhum gancho no código de produção.
  const created: string[] = [];
  afterEach(async () => {
    for (const statement of created.splice(0)) await db.sql(statement);
  });

  async function failOn(table: string, condition: string, sqlstate: string) {
    const name = `fail_${randomUUID().replaceAll('-', '')}`;
    await db.sql(`CREATE FUNCTION ${name}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'falha injetada' USING ERRCODE = '${sqlstate}'; END; $$ LANGUAGE plpgsql`);
    await db.sql(`CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION ${name}()`);
    const drop = [`DROP TRIGGER IF EXISTS ${name} ON ${table}`, `DROP FUNCTION IF EXISTS ${name}()`];
    created.push(...drop);
    return async () => { for (const statement of drop) await db.sql(statement); };
  }

  const points: Array<[string, (walletId: string) => [string, string]]> = [
    ['ao gravar o saldo', (id) => ['wallets', `NEW.id = '${id}' AND NEW.version > 1`]],
    ['ao gravar o lançamento', (id) => ['wallet_ledger_entries', `NEW.wallet_id = '${id}' AND NEW.wallet_version > 1`]],
    ['no primeiro evento', (id) => ['outbox_messages', `NEW.event_type = 'WagerTransactionProcessed' AND NEW.payload->'data'->>'walletId' = '${id}' AND NEW.payload->'data'->>'kind' = 'BET'`]],
    ['no último evento', (id) => ['outbox_messages', `NEW.event_type = 'WalletBalanceChanged' AND NEW.payload->'data'->>'walletId' = '${id}' AND (NEW.payload->'data'->>'walletVersion')::int > 1`]],
  ];

  async function assertNothingApplied(wallet: OpenedWallet, external: string) {
    expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 1 });
    expect(await movementsOf(db, wallet.id)).toHaveLength(0);
    expect(await eventsOf(wallet.id)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']); // só a abertura
    await assertFinancialInvariants(db, wallet.id);
    return db.sql<{ status: string }>('SELECT status FROM wager_transactions WHERE external_transaction_id = ?', [external]);
  }

  for (const [where, point] of points) {
    test(`falha transitória ${where}: 503, nada gravado, e o reenvio aplica uma vez`, async () => {
      const wallet = await openWallet();
      const bet = payload(wallet, 'BET');
      const [table, condition] = point(wallet.id);
      const heal = await failOn(table, condition, '55P03');

      const replies = await Promise.all(Array.from({ length: 6 }, () => submit(bet)));
      expect(new Set(statuses(replies))).toEqual(new Set([503]));
      expect(await assertNothingApplied(wallet, bet.externalTransactionId)).toHaveLength(0);

      await heal();
      const retried = await Promise.all(Array.from({ length: 6 }, () => submit(bet)));
      expect(statuses(retried)).toEqual([200, 200, 200, 200, 200, 201]);
      expect(await walletRow(wallet.id)).toEqual({ balance: '75.00', version: 2 });
      expect(await movementsOf(db, wallet.id)).toHaveLength(1);
      await assertFinancialInvariants(db, wallet.id);
    }, TIMEOUT);

    test(`constraint violada ${where}: 500, FAILED auditável e nenhum efeito`, async () => {
      const wallet = await openWallet();
      const bet = payload(wallet, 'BET');
      const [table, condition] = point(wallet.id);
      await failOn(table, condition, '23514');

      const first = await submit(bet);
      expect(first.status).toBe(500);
      expect(first.body.code).toBe('INTERNAL_ERROR');
      const rows = await assertNothingApplied(wallet, bet.externalTransactionId);
      expect(rows.map((r) => r.status)).toEqual(['FAILED']);

      // FAILED é terminal: o reenvio é replay, nunca uma nova tentativa de débito.
      const replay = await submit(bet);
      expect(replay.status).toBe(500);
      expect(replay.body).toMatchObject({ status: 'FAILED', failureCode: 'INTERNAL_ERROR', idempotentReplay: true });
      await assertNothingApplied(wallet, bet.externalTransactionId);
    }, TIMEOUT);
  }

  test('erro inesperado do banco: 500 sem estado terminal, e o reenvio aplica', async () => {
    const wallet = await openWallet();
    const bet = payload(wallet, 'BET');
    const [table, condition] = points[1]![1](wallet.id);
    const heal = await failOn(table, condition, 'P0001');
    const reply = await submit(bet);
    expect(reply.status).toBe(500);
    expect(await assertNothingApplied(wallet, bet.externalTransactionId)).toHaveLength(0);
    await heal();
    expect((await submit(bet)).status).toBe(201);
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);

  test('sessão derrubada no meio da transação: 503, sem efeito parcial, e o reenvio aplica', async () => {
    const wallet = await openWallet();
    const bet = payload(wallet, 'BET');
    const lock = await holdWalletLock(db, wallet.id);
    const pending = submit(bet);
    await waitForBlockedSessions(db, 1);
    await db.sql(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%wallets%for update%'`,
    );
    expect((await pending).status).toBe(503);
    await lock.release();
    expect(await assertNothingApplied(wallet, bet.externalTransactionId)).toHaveLength(0);
    expect((await submit(bet)).status).toBe(201);
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);

  test('sessão derrubada depois de gravar a transação e o saldo: nada fica confirmado', async () => {
    const wallet = await openWallet();
    const bet = payload(wallet, 'BET');
    const name = `sleep_${randomUUID().replaceAll('-', '')}`;
    await db.sql(`CREATE FUNCTION ${name}() RETURNS trigger AS $$ BEGIN PERFORM pg_sleep(30); RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await db.sql(`CREATE TRIGGER ${name} BEFORE INSERT ON wallet_ledger_entries FOR EACH ROW WHEN (NEW.wallet_id = '${wallet.id}' AND NEW.wallet_version > 1) EXECUTE FUNCTION ${name}()`);
    created.push(`DROP TRIGGER IF EXISTS ${name} ON wallet_ledger_entries`, `DROP FUNCTION IF EXISTS ${name}()`);

    const pending = submit(bet);
    const deadline = Date.now() + 10_000;
    let sleeping = 0;
    while (sleeping === 0 && Date.now() < deadline) {
      [{ n: sleeping }] = (await db.sql<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'PgSleep'`)) as [{ n: number }];
    }
    expect(sleeping).toBe(1);
    await db.sql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'PgSleep'`);

    expect((await pending).status).toBe(503);
    expect(await assertNothingApplied(wallet, bet.externalTransactionId)).toHaveLength(0);
  }, TIMEOUT);

  test('mais quedas que o tamanho do pool: a instância continua atendendo e encerra normalmente', async () => {
    const wallet = await openWallet('1000.00');
    const instance = await startApiCluster(db, 1, { DB_CONNECT_TIMEOUT_MS: '2000' });
    const send = () => {
      const bet = payload(wallet, 'BET', { money: brl('1.00') });
      return instance.call('POST', '/wagering/transactions', bet, { 'Idempotency-Key': randomUUID() });
    };
    let closed = false;
    try {
      for (let drop = 0; drop < 12; drop++) {
        const lock = await holdWalletLock(db, wallet.id);
        const pending = send();
        await waitForBlockedSessions(db, 1);
        await db.sql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%wallets%for update%'`);
        expect((await pending).status).toBe(503);
        await lock.release();
        expect((await send()).status).toBe(201);
      }
      const finished = await Promise.race([instance.close().then(() => true), Bun.sleep(5000).then(() => false)]);
      closed = finished;
      expect(finished).toBe(true);
    } finally {
      if (!closed) void instance.close();
    }
    expect(await walletRow(wallet.id)).toEqual({ balance: '988.00', version: 13 });
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);

  test('statement timeout real: 503 (SQLSTATE 57014), nunca 500', async () => {
    const wallet = await openWallet();
    const bet = payload(wallet, 'BET');
    const impatient = await startApiCluster(db, 1, { DB_QUERY_TIMEOUT_MS: '200', DB_LOCK_TIMEOUT_MS: '5000' });
    const lock = await holdWalletLock(db, wallet.id);
    try {
      const reply = await impatient.call('POST', '/wagering/transactions', bet, { 'Idempotency-Key': randomUUID() });
      expect(reply.status).toBe(503);
      expect(reply.body.code).toBe('TEMPORARILY_UNAVAILABLE');
    } finally {
      await lock.release();
      await impatient.close();
    }
    expect(await assertNothingApplied(wallet, bet.externalTransactionId)).toHaveLength(0);
  }, TIMEOUT);

  test('falha em uma wallet não atinge as operações simultâneas de outra', async () => {
    const [broken, healthy] = [await openWallet(), await openWallet()];
    const [table, condition] = points[1]![1](broken.id);
    await failOn(table, condition, '55P03');
    const replies = await Promise.all([
      ...Array.from({ length: 5 }, () => submit(payload(broken, 'BET', { money: brl('1.00') }))),
      ...Array.from({ length: 5 }, () => submit(payload(healthy, 'BET', { money: brl('1.00') }))),
    ]);
    expect(statuses(replies.slice(0, 5))).toEqual(Array(5).fill(503));
    expect(statuses(replies.slice(5))).toEqual(Array(5).fill(201));
    expect(await walletRow(broken.id)).toEqual({ balance: '100.00', version: 1 });
    expect(await walletRow(healthy.id)).toEqual({ balance: '95.00', version: 6 });
    await assertFinancialInvariants(db, broken.id);
    await assertFinancialInvariants(db, healthy.id);
  }, TIMEOUT);
});

describe('garantias que não dependem da aplicação', () => {
  test('a idempotência sobrevive à troca de todas as instâncias: nada fica em memória', async () => {
    const wallet = await openWallet();
    const bet = payload(wallet, 'BET');
    const first = await submit(bet);
    const fresh = await startApiCluster(db, 2);
    try {
      const replies = await Promise.all(Array.from({ length: 10 }, () => fresh.call('POST', '/wagering/transactions', bet, { 'Idempotency-Key': `${bet.providerId}:${bet.externalTransactionId}` })));
      expect(new Set(statuses(replies))).toEqual(new Set([200]));
      for (const reply of replies) expect(reply.body).toEqual({ ...first.body, idempotentReplay: true });
    } finally {
      await fresh.close();
    }
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);

  test('sem a aplicação, o banco barra saldo negativo sob UPDATEs simultâneos', async () => {
    const wallet = await openWallet();
    const results = await Promise.allSettled(
      Array.from({ length: 2 }, () => db.sql('UPDATE wallets SET balance = balance - 80 WHERE id = ?', [wallet.id])),
    );
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await walletRow(wallet.id)).balance).toBe('20.00');
  }, TIMEOUT);

  test('sem a aplicação, duas linhas com a mesma chave não coexistem', async () => {
    const wallet = await openWallet();
    const insert = (external: string) => db.sql(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, observed_balance, observed_balance_currency, created_at, processed_at)
       VALUES (?, 'provider-a', ?, ?, ?, ?, ?, 'r', 'g', 'LOSS', 1, 'BRL', 'PROCESSED', 100, 'BRL', now(), now())`,
      [randomUUID(), external, `chave-${wallet.id}`, 'c'.repeat(64), wallet.id, wallet.playerId],
    );
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => insert(`${wallet.id}-${i}`)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  }, TIMEOUT);

  test('o ledger não pode ser alterado nem excluído, mesmo durante operações em andamento', async () => {
    const wallet = await openWallet();
    const bets = Array.from({ length: 4 }, () => submit(payload(wallet, 'BET', { money: brl('1.00') })));
    const attacks = await Promise.allSettled([
      db.sql('UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = ?', [wallet.id]),
      db.sql('DELETE FROM wallet_ledger_entries WHERE wallet_id = ?', [wallet.id]),
      db.sql('TRUNCATE wallet_ledger_entries CASCADE'),
    ]);
    await Promise.all(bets);
    expect(attacks.map((a) => a.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(await movementsOf(db, wallet.id)).toHaveLength(4);
    await assertFinancialInvariants(db, wallet.id);
  }, TIMEOUT);

  test('o verificador de invariantes detecta divergência: um saldo adulterado não passa', async () => {
    const wallet = await openWallet();
    await submit(payload(wallet, 'BET'));
    await assertFinancialInvariants(db, wallet.id);
    await db.sql('UPDATE wallets SET balance = balance + 0.01 WHERE id = ?', [wallet.id]);
    let failed = false;
    try {
      await assertFinancialInvariants(db, wallet.id);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  }, TIMEOUT);
});
