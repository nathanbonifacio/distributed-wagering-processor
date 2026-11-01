import { describe, expect, test } from 'bun:test';
import { InboxMessage } from '../../src/app/messaging/domain/inbox-message';
import { T0, T1 } from '../support/wagering-fixtures';

const props = { consumerName: 'consumer', messageId: 'message-1', payloadHash: 'a'.repeat(64), receivedAt: T0 };

describe('InboxMessage', () => {
  test('a received message is not processed yet', () => {
    const message = InboxMessage.receive(props);
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
    expect(message.receivedAt).toEqual(T0);
  });

  test('markProcessed records the time', () => {
    const message = InboxMessage.receive(props);
    message.markProcessed(T1);
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(T1);
  });

  test('matchesPayload compares the hash', () => {
    const message = InboxMessage.receive(props);
    expect(message.matchesPayload('a'.repeat(64))).toBe(true);
    expect(message.matchesPayload('b'.repeat(64))).toBe(false);
  });

  test('rehydrate rebuilds the persisted state', () => {
    expect(InboxMessage.rehydrate({ ...props, processedAt: T1 }).isProcessed()).toBe(true);
    expect(InboxMessage.rehydrate(props).isProcessed()).toBe(false);
  });
});
