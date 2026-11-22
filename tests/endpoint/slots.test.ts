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

  it('hands out only what a smaller count leaves, even once a slot held past it is released', () => {
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

  it('never hands out, from an allocator made before a shrink, a slot past the new total', () => {
    const before = slotAllocator(endpoint, 'm', 4);
    before.acquire('a');
    before.acquire('b');
    before.acquire('c');
    const after = slotAllocator(endpoint, 'm', 2);
    expect(before.total).toBe(2);
    expect(before.acquire('d')).toBeUndefined();
    expect(after.acquire('e')).toBeUndefined();
  });

  it('never hands out a slot held across a shrink and a regrow a second time', () => {
    const first = slotAllocator(endpoint, 'm', 4);
    first.acquire('a');
    first.acquire('b');
    expect(first.acquire('c')).toBe(2);
    slotAllocator(endpoint, 'm', 2);
    const regrown = slotAllocator(endpoint, 'm', 4);
    // `c` still holds slot 2, so the newcomers get the one nobody holds, and then nothing.
    expect(regrown.acquire('f')).toBe(3);
    expect(regrown.acquire('g')).toBeUndefined();
    // And `c` gives it back through the allocator it took it from.
    first.release('c');
    expect(regrown.acquire('g')).toBe(2);
  });

  it('frees nothing for a session that holds no slot', () => {
    // What the loop does for an exchange that asked for a slot and was given none.
    const slots = slotAllocator(endpoint, 'm', 1);
    slots.acquire('a');
    slots.release('b');
    expect(slots.acquire('c')).toBeUndefined();
  });

  it('hands out nothing on a server with no slots', () => {
    expect(slotAllocator(endpoint, 'm', 0).acquire('a')).toBeUndefined();
  });
});
