import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { WagerTransactionKind as Kind } from '../../src/app/wagering/domain/wager-transaction.entity';
import { type WagerPayload, wagerPayloadHash } from '../../src/app/wagering/application/wager-payload-hash';
import { canonicalJson } from '../../src/shared/application/canonical-json';
import { Money } from '../../src/shared/domain/money';

const payload = (overrides: Partial<WagerPayload> = {}): WagerPayload => ({
  providerId: 'provider-a',
  externalTransactionId: 'ext-1',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-1',
  gameId: 'fortune-chimp',
  kind: Kind.Bet,
  money: Money.from({ amount: '25.00', currency: 'BRL' }),
  ...overrides,
});

describe('canonicalJson', () => {
  test('sorts the keys recursively, including inside lists', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: 3 } })).toBe('{"a":{"c":3,"d":[{"y":2,"z":1}]},"b":1}');
  });

  test('the insertion order of the keys does not change the result', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  test('an undefined field is the same as an absent field, but null is not', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson({ a: 1, b: null })).toBe('{"a":1,"b":null}');
  });
});

describe('wagerPayloadHash', () => {
  test('it is the SHA-256 of the documented canonical JSON', () => {
    const canonical =
      '{"externalTransactionId":"ext-1","gameId":"fortune-chimp","kind":"BET",' +
      '"money":{"amount":"25.00","currency":"BRL"},"playerId":"player-1","providerId":"provider-a",' +
      '"roundId":"round-1","walletId":"wallet-1"}';
    expect(wagerPayloadHash(payload())).toBe(createHash('sha256').update(canonical).digest('hex'));
  });

  test('the order of the received fields does not change the hash', () => {
    const { providerId, ...rest } = payload();
    expect(wagerPayloadHash({ ...rest, providerId })).toBe(wagerPayloadHash(payload()));
  });

  test('transport metadata is not part of it', () => {
    const withTransport = { ...payload(), idempotencyKey: 'k', messageId: 'm', correlationId: 'c', causationId: 'x' };
    expect(wagerPayloadHash(withTransport)).toBe(wagerPayloadHash(payload()));
  });

  test.each<[string, Partial<WagerPayload>]>([
    ['providerId', { providerId: 'provider-b' }],
    ['externalTransactionId', { externalTransactionId: 'ext-2' }],
    ['playerId', { playerId: 'player-2' }],
    ['walletId', { walletId: 'wallet-2' }],
    ['roundId', { roundId: 'round-2' }],
    ['gameId', { gameId: 'other' }],
    ['kind', { kind: Kind.Win }],
    ['amount', { money: Money.from({ amount: '25.01', currency: 'BRL' }) }],
    ['currency', { money: Money.from({ amount: '25.00', currency: 'USD' }) }],
    ['reference', { referenceExternalTransactionId: 'ext-0' }],
  ])('each business field changes the hash: %s', (_field, change) => {
    expect(wagerPayloadHash(payload(change))).not.toBe(wagerPayloadHash(payload()));
  });

  test('the format is the one the database requires', () => {
    expect(wagerPayloadHash(payload())).toMatch(/^[0-9a-f]{64}$/);
  });
});
