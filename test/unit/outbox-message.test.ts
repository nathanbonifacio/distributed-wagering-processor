import { describe, expect, test } from 'bun:test';
import { InvalidOutboxTransitionError, OutboxMessage } from '../../src/app/messaging/domain/outbox-message';
import { WalletBalanceChanged } from '../../src/app/wallet/domain/events/wallet-balance-changed';
import { brl, openWallet, T0, T1 } from '../support/wagering-fixtures';

function newMessage() {
  const entry = openWallet().debit({ entryId: 'e', transactionId: 't', money: brl('25.00'), at: T0 });
  return OutboxMessage.enqueue(WalletBalanceChanged.from(entry, { eventId: 'event-1', correlationId: 'c', occurredAt: T0 }));
}

describe('OutboxMessage', () => {
  test('enqueue: pendente, vencida, com o eventId como id e o envelope no payload', () => {
    const message = newMessage();
    expect(message.id).toBe('event-1');
    expect(message.eventType).toBe('WalletBalanceChanged');
    expect(message.payload).toMatchObject({ eventId: 'event-1', version: 1, data: { money: { amount: '25.00', currency: 'BRL' } } });
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(T0)).toBe(true);
  });

  test('isDue respeita o horário e deixa de valer depois de publicada', () => {
    const message = newMessage();
    expect(message.isDue(new Date(T0.getTime() - 1))).toBe(false);
    message.markPublished(T1);
    expect(message.isPending()).toBe(false);
    expect(message.isDue(T1)).toBe(false);
    expect(message.publishedAt).toEqual(T1);
  });

  test('backoff dobra até 5 minutos, conta tentativas e guarda o último erro', () => {
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

  test('publicada é terminal', () => {
    const message = newMessage();
    message.markPublished(T1);
    expect(() => message.markPublished(T1)).toThrow(InvalidOutboxTransitionError);
    expect(() => message.scheduleRetry(T1)).toThrow(InvalidOutboxTransitionError);
  });

  test('rehydrate reconstrói o estado sem revalidar', () => {
    const message = OutboxMessage.rehydrate({ id: 'x', aggregateId: 'a', eventType: 'E', payload: {}, occurredAt: T0, attempts: 3, nextAttemptAt: T1, publishedAt: T1, lastError: 'e' });
    expect(message.attempts).toBe(3);
    expect(message.isPending()).toBe(false);
    expect(message.lastError).toBe('e');
  });
});
