import { describe, expect, it } from 'vitest';
import { EventBus } from './event-bus.js';

const event = {
  id: 'evt-1',
  timestamp: new Date(),
  source: 'system',
  type: 'edge.wake',
  severity: 'info',
  data: {},
} as any;

describe('EventBus delivery', () => {
  it('awaits wildcard subscribers before publish resolves', async () => {
    const bus = new EventBus();
    let finished = false;

    bus.subscribeAll(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      finished = true;
    });

    await bus.emit(event);

    expect(finished).toBe(true);
  });

  it('contains wildcard subscriber failures without rejecting the publish', async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribeAll(async () => {
      throw new Error('observer failed');
    });
    bus.subscribe('edge.wake', () => {
      seen.push('typed');
    });

    await expect(bus.emit(event)).resolves.toBeUndefined();
    expect(seen).toEqual(['typed']);
  });
});
