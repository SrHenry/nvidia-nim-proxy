import { describe, it, expect, beforeEach } from 'vitest';
import { createSnowflakeGenerator } from '../../../src/infrastructure/database/snowflake.js';

describe('Snowflake ID Generator', () => {
  let gen;

  beforeEach(() => {
    gen = createSnowflakeGenerator({ workerId: 0 });
  });

  it('generates a BigInt', () => {
    const id = gen.next();
    expect(typeof id).toBe('bigint');
  });

  it('generates monotonically increasing IDs', () => {
    const ids = [];
    for (let i = 0; i < 1000; i++) {
      ids.push(gen.next());
    }
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i] > ids[i - 1]).toBe(true);
    }
  });

  it('generates unique IDs within the same millisecond', () => {
    const ids = new Set();
    for (let i = 0; i < 4096; i++) {
      ids.add(gen.next());
    }
    expect(ids.size).toBe(4096);
  });

  it('incorporates workerId in generated ID', () => {
    const gen0 = createSnowflakeGenerator({ workerId: 0 });
    const gen1 = createSnowflakeGenerator({ workerId: 1 });

    const id0 = gen0.next();
    const id1 = gen1.next();

    const worker0 = Number((id0 >> 12n) & 0x3FFn);
    const worker1 = Number((id1 >> 12n) & 0x3FFn);
    expect(worker0).toBe(0);
    expect(worker1).toBe(1);
  });

  it('supports max workerId (1023)', () => {
    const gen2 = createSnowflakeGenerator({ workerId: 1023 });
    const id = gen2.next();
    const worker = Number((id >> 12n) & 0x3FFn);
    expect(worker).toBe(1023);
  });
});
