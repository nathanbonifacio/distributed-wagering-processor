import { describe, expect, test } from 'bun:test';
import type { ReconciliationSnapshot } from '../../src/app/wallet/application/ports/ledger.repository.port';
import type {
  ReconciliationDivergence,
  ReconciliationObserver,
} from '../../src/app/wallet/application/ports/reconciliation-observer.port';
import type { WalletPersistence } from '../../src/app/wallet/application/ports/wallet-persistence.port';
import { ReconcileWallet } from '../../src/app/wallet/application/reconcile-wallet.use-case';
import type { UnitOfWork } from '../../src/shared/application/unit-of-work.port';
import { brl } from '../support/wagering-fixtures';

const WALLET = 'wallet-1';

function build(snapshot: ReconciliationSnapshot | undefined) {
  const divergences: ReconciliationDivergence[] = [];
  let writes = 0;
  const persistence = {
    wallets: new Proxy({}, { get: () => () => { writes += 1; } }),
    ledger: { reconciliationSnapshot: async () => snapshot },
  } as unknown as WalletPersistence;
  const unitOfWork: UnitOfWork<WalletPersistence> = { run: (work) => work(persistence) };
  const observer: ReconciliationObserver = { divergenceDetected: (divergence) => divergences.push(divergence) };
  return { useCase: new ReconcileWallet(unitOfWork, observer), divergences, writes: () => writes };
}

const snapshot = (stored: string, calculated: string, entryCount = 3, foreignCurrencyEntries = 0): ReconciliationSnapshot => ({
  storedBalance: brl(stored),
  calculatedBalance: brl(calculated),
  entryCount,
  foreignCurrencyEntries,
});

describe('ReconcileWallet', () => {
  test('equal balances are consistent, with a zero difference, and nobody is notified', async () => {
    const { useCase, divergences } = build(snapshot('975.00', '975.00', 42));
    const report = await useCase.execute(WALLET);
    expect(report?.consistent).toBe(true);
    expect(report?.difference.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(report?.checkedEntries).toBe(42);
    expect(divergences).toHaveLength(0);
  });

  test('a surplus in the stored balance is a positive difference and notifies the observer once', async () => {
    const { useCase, divergences } = build(snapshot('107.50', '100.00'));
    const report = await useCase.execute(WALLET);
    expect(report).toMatchObject({ consistent: false, walletId: WALLET });
    expect(report?.difference.toJSON().amount).toBe('7.50');
    expect(report?.storedBalance.toJSON().amount).toBe('107.50');
    expect(report?.calculatedBalance.toJSON().amount).toBe('100.00');
    expect(divergences).toHaveLength(1);
    expect(divergences[0]?.walletId).toBe(WALLET);
    expect(divergences[0]?.difference.toJSON().amount).toBe('7.50');
  });

  test('a deficit is a negative difference, with exact cents', async () => {
    const { useCase } = build(snapshot('99.93', '100.00'));
    expect((await useCase.execute(WALLET))?.difference.toJSON().amount).toBe('-0.07');
  });

  test('a decimal sum that floating point would get wrong is exact', async () => {
    const { useCase } = build(snapshot('0.30', '0.30'));
    expect((await useCase.execute(WALLET))?.consistent).toBe(true);
  });

  test('a foreign currency entry is a divergence even when the difference is zero', async () => {
    const { useCase, divergences } = build(snapshot('100.00', '100.00', 2, 1));
    const report = await useCase.execute(WALLET);
    expect(report?.consistent).toBe(false);
    expect(report?.difference.isZero()).toBe(true);
    expect(divergences[0]?.foreignCurrencyEntries).toBe(1);
  });

  test('an unknown wallet is undefined, and the observer is not notified', async () => {
    const { useCase, divergences } = build(undefined);
    expect(await useCase.execute(WALLET)).toBeUndefined();
    expect(divergences).toHaveLength(0);
  });

  test('it never writes: the wallet repository is untouched, even on a divergence', async () => {
    const { useCase, writes } = build(snapshot('1.00', '2.00'));
    await useCase.execute(WALLET);
    expect(writes()).toBe(0);
  });
});
