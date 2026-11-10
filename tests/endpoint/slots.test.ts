import { beforeEach, describe, expect, it } from 'vitest';
import { resetSlots, slotAllocator } from '../../src/endpoint/slots.ts';
import { endpoint } from '../helpers.ts';

describe('slotAllocator', () => {
  beforeEach(() => {
    resetSlots();
  });

  it('gives each session a slot of its own until there are none left', () => {
    const slots = slotAllocator(endpoint, 'm', 2);
    expect(slots.acquire('a')).toBe(0);
    expect(slots.acquire('b')).toBe(1);
    // More sessions than slots get no pin, and are not queued.
    expect(slots.acquire('c')).toBeUndefined();
  });

  it('hands a session back the slot it last held, where that is free', () => {
    const slots = slotAllocator(endpoint, 'm', 3);
    slots.acquire('a');
    expect(slots.acquire('b')).toBe(1);
    slots.release('b');
    slots.release('a');
    // Slot 2 has never been held and would be the pick for a newcomer; each of these gets its own.
    expect(slots.acquire('b')).toBe(1);
    expect(slots.acquire('a')).toBe(0);
  });

  it("takes a slot nobody has held before one that holds another session's cache", () => {
    const slots = slotAllocator(endpoint, 'm', 2);
    slots.acquire('a');
    slots.release('a');
    expect(slots.acquire('b')).toBe(1);
  });

  it('takes the slot released longest ago once every slot has been held', () => {
    const slots = slotAllocator(endpoint, 'm', 2);
    slots.acquire('a');
    slots.acquire('b');
    slots.release('b');
    slots.release('a');
    expect(slots.acquire('c')).toBe(1);
  });

  it('gives a session that already holds a slot no second one', () => {
    const slots = slotAllocator(endpoint, 'm', 2);
    expect(slots.acquire('a')).toBe(0);
    expect(slots.acquire('a')).toBeUndefined();
    // The refusal took nothing: one release frees the slot, and the session can have it again.
    slots.release('a');
    expect(slots.acquire('a')).toBe(0);
  });

  it('shares one set of slots between every allocator for the endpoint, whatever its key', () => {
    slotAllocator(endpoint, 'm', 1).acquire('a');
    expect(slotAllocator({ ...endpoint, baseUrl: `${endpoint.baseUrl}/` }, 'm', 1).acquire('b')).toBeUndefined();
    expect(slotAllocator(endpoint, 'other', 1).acquire('b')).toBe(0);
  });

  it('drops the slots a smaller count no longer has, and a holder of one releases into nothing', () => {
    const before = slotAllocator(endpoint, 'm', 2);
    before.acquire('a');
    before.acquire('b');
    const after = slotAllocator(endpoint, 'm', 1);
    expect(after.total).toBe(1);
    before.release('b');
    expect(after.acquire('c')).toBeUndefined();
    before.release('a');
    expect(after.acquire('c')).toBe(0);
  });

  it('hands out nothing on a server with no slots', () => {
    expect(slotAllocator(endpoint, 'm', 0).acquire('a')).toBeUndefined();
  });
});
