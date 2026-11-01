import { describe, expect, test } from 'bun:test';
import { InvalidOutboxTransitionError, OutboxMessage } from '../../src/app/messaging/domain/outbox-message';
import { WalletBalanceChanged } from '../../src/app/wallet/domain/events/wallet-balance-changed';
import { brl, openWallet, T0, T1 } from '../support/wagering-fixtures';

function newMessage() {
  const entry = openWallet().debit({ entryId: 'e', transactionId: 't', money: brl('25.00'), at: T0 });
  return OutboxMessage.enqueue(WalletBalanceChanged.from(entry, { eventId: 'event-1', correlationId: 'c', occurredAt: T0 }));
}

describe('OutboxMessage', () => {
  test('enqueue: pending, due, with the eventId as id and the envelope in the payload', () => {
    const message = newMessage();
    expect(message.id).toBe('event-1');
    expect(message.eventType).toBe('WalletBalanceChanged');
    expect(message.payload).toMatchObject({ eventId: 'event-1', version: 1, data: { money: { amount: '25.00', currency: 'BRL' } } });
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(T0)).toBe(true);
  });

  test('isDue respects the schedule and stops holding once published', () => {
    const message = newMessage();
    expect(message.isDue(new Date(T0.getTime() - 1))).toBe(false);
    message.markPublished(T1);
    expect(message.isPending()).toBe(false);
    expect(message.isDue(T1)).toBe(false);
    expect(message.publishedAt).toEqual(T1);
  });

  test('backoff doubles up to 5 minutes, counts attempts and keeps the last error', () => {
    const message = newMessage();
    const delays: number[] = [];
    for (let i = 0; i < 12; i++) {
      message.scheduleRetry(T0, 'TimeoutError');
      delays.push(message.nextAttemptAt.getTime() - T0.getTime());
    }
    expect(delays.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
    expect(delays.at(-1)).toBe(300_000);
    expect(message.attempts).toBe(12);
    expect(message.lastError).toBe('TimeoutError');
    expect(message.isPending()).toBe(true);
  });

  test('published is terminal', () => {
    const message = newMessage();
    message.markPublished(T1);
    expect(() => message.markPublished(T1)).toThrow(InvalidOutboxTransitionError);
    expect(() => message.scheduleRetry(T1)).toThrow(InvalidOutboxTransitionError);
  });

  describe('settling a reservation', () => {
    const reserved = (attempts = 0) =>
      OutboxMessage.rehydrate({ id: 'x', aggregateId: 'a', eventType: 'E', payload: {}, occurredAt: T0, attempts, nextAttemptAt: T1 });

    test('the current reservation reschedules with backoff over the stored attempts', () => {
      const message = reserved(2);
      message.registerFailure(T1, T1, 'TimeoutError');
      expect(message.attempts).toBe(3);
      expect(message.nextAttemptAt).toEqual(new Date(T1.getTime() + 4000));
      expect(message.lastError).toBe('TimeoutError');
    });

    test('a replaced reservation counts the failure and keeps the schedule', () => {
      const message = reserved(2);
      message.registerFailure(T0, T1, 'TimeoutError');
      expect(message.attempts).toBe(3);
      expect(message.nextAttemptAt).toEqual(T1);
      expect(message.lastError).toBe('TimeoutError');
    });

    test('nothing changes once published, and the first publication date stays', () => {
      const message = reserved();
      message.confirmPublished(T0);
      message.confirmPublished(T1);
      message.registerFailure(T1, T1, 'TimeoutError');
      expect(message.publishedAt).toEqual(T0);
      expect(message.attempts).toBe(0);
      expect(message.lastError).toBeUndefined();
    });
  });

  test('rehydrate rebuilds the state without revalidating', () => {
    const message = OutboxMessage.rehydrate({ id: 'x', aggregateId: 'a', eventType: 'E', payload: {}, occurredAt: T0, attempts: 3, nextAttemptAt: T1, publishedAt: T1, lastError: 'e' });
    expect(message.attempts).toBe(3);
    expect(message.isPending()).toBe(false);
    expect(message.lastError).toBe('e');
  });
});

describe('persisted state', () => {
  test('rehydrate remembers what the row held, and later changes do not alter it', () => {
    const message = OutboxMessage.rehydrate({ id: 'x', aggregateId: 'a', eventType: 'E', payload: {}, occurredAt: T0, attempts: 2, nextAttemptAt: T1 });
    message.scheduleRetry(T1, 'TimeoutError');
    expect(message.attempts).toBe(3);
    expect(message.persistedState).toEqual({ attempts: 2, nextAttemptAt: T1 });
  });

  test('the exposed baseline cannot be used to change it', () => {
    const message = OutboxMessage.rehydrate({ id: 'x', aggregateId: 'a', eventType: 'E', payload: {}, occurredAt: T0, attempts: 0, nextAttemptAt: T1 });
    message.persistedState!.nextAttemptAt.setTime(0);
    expect(message.persistedState!.nextAttemptAt).toEqual(T1);
  });

  test('a message born from enqueue has no baseline: it was never read from the table', () => {
    expect(newMessage().persistedState).toBeUndefined();
  });
});
