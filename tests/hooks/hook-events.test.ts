import { describe, expect, it } from 'vitest';
import { HOOK_EVENTS, HookEvent, INJECT_EVENTS } from '../../src/hooks/hook-events.ts';

describe('HookEvent', () => {
  it('names the exchange events after the exchange', () => {
    expect(HookEvent.BeforeExchange).toBe('beforeExchange');
    expect(HookEvent.AfterExchange).toBe('afterExchange');
  });
});

describe('HOOK_EVENTS', () => {
  it('lists each event once, in the order a session meets them', () => {
    expect(HOOK_EVENTS).toEqual([
      'sessionStart',
      'beforeExchange',
      'afterExchange',
      'beforeCompact',
      'sessionEnd',
      'sessionDelete',
    ]);
  });
});

describe('INJECT_EVENTS', () => {
  it('holds the events that run before a request', () => {
    expect([...INJECT_EVENTS]).toEqual(['sessionStart', 'beforeExchange']);
  });
});
