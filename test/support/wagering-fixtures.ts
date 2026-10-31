import { Money } from '../../src/shared/domain/money';
import { Wallet } from '../../src/wallet/domain/wallet';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
} from '../../src/wagering/domain/wager-transaction';

export const T0 = new Date('2026-10-31T12:00:00.000Z');
export const T1 = new Date('2026-10-31T12:00:01.000Z');
export const T2 = new Date('2026-10-31T12:00:02.000Z');

export const WALLET_ID = 'wallet-1';
export const PLAYER_ID = 'player-1';
export const PROVIDER_ID = 'provider-a';
export const ROUND_ID = 'round-1';

export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

export const openWallet = (amount = '100.00') =>
  Wallet.open({ id: WALLET_ID, playerId: PLAYER_ID, initialBalance: brl(amount), at: T0 });

export function txProps(
  kind: WagerTransactionKind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps {
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${kind}`;
  return {
    id: `tx-${externalTransactionId}`,
    providerId: PROVIDER_ID,
    externalTransactionId,
    idempotencyKey: `${PROVIDER_ID}:${externalTransactionId}`,
    payloadHash: `hash-${externalTransactionId}`,
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: ROUND_ID,
    gameId: 'fortune-chimp',
    kind,
    money: brl('25.00'),
    createdAt: T0,
    ...overrides,
  };
}

export const newTx = (kind: WagerTransactionKind, overrides: Partial<CreateWagerTransactionProps> = {}) =>
  WagerTransaction.create(txProps(kind, overrides));

/** Transação já PROCESSED, como viria do banco. */
export function processedTx(kind: WagerTransactionKind, overrides: Partial<CreateWagerTransactionProps> = {}) {
  const transaction = newTx(kind, overrides);
  transaction.markProcessed(overrides.referenceExternalTransactionId ? 'tx-some-reference' : undefined, T0);
  return transaction;
}
