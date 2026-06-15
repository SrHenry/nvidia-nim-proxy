import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BufferedRepository } from '../../../src/infrastructure/database/buffered-repository.js';

describe('BufferedRepository', () => {
  let inner;
  let buf;

  beforeEach(() => {
    inner = {
      insertBatch: vi.fn(),
      count: vi.fn().mockReturnValue(42),
      prune: vi.fn().mockReturnValue(5),
    };
    buf = new BufferedRepository(inner, { flushIntervalMs: 5000, batchSize: 10 });
  });

  afterEach(() => {
    buf.destroy();
  });

  it('buffers inserts without flushing immediately', () => {
    buf.insert({ model: 'test' });
    expect(inner.insertBatch).not.toHaveBeenCalled();
    expect(buf.buffer.length).toBe(1);
  });

  it('flushes when batch size is reached', () => {
    for (let i = 0; i < 10; i++) {
      buf.insert({ model: `m${i}` });
    }
    expect(inner.insertBatch).toHaveBeenCalledTimes(1);
    expect(inner.insertBatch).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ model: 'm0' })])
    );
    expect(buf.buffer.length).toBe(0);
  });

  it('passes read operations through directly', () => {
    const count = buf.count();
    expect(count).toBe(42);
    expect(inner.count).toHaveBeenCalledTimes(1);

    const pruned = buf.prune(1000);
    expect(pruned).toBe(5);
    expect(inner.prune).toHaveBeenCalledWith(1000);
  });

  it('starts timer on first insert', () => {
    expect(buf.flushTimer).toBeNull();
    buf.insert({ model: 'test' });
    expect(buf.flushTimer).toBeDefined();
  });

  it('calls insertBatch on drain and clears timer', async () => {
    buf.insert({ model: 'a' });
    buf.insert({ model: 'b' });
    await buf.drain();
    expect(inner.insertBatch).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ model: 'a' }),
        expect.objectContaining({ model: 'b' }),
      ])
    );
    expect(buf.buffer.length).toBe(0);
  });

  it('drains multiple times without error', async () => {
    buf.insert({ model: 'x' });
    await buf.drain();
    await buf.drain();
    expect(inner.insertBatch).toHaveBeenCalledTimes(1);
  });

  it('flushes remaining buffer on timer', async () => {
    buf.insert({ model: 'pending' });
    buf.flush();
    await buf.pendingFlush;
    expect(inner.insertBatch).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ model: 'pending' })])
    );
  });

  it('does not flush when buffer is empty', () => {
    buf.flush();
    expect(inner.insertBatch).not.toHaveBeenCalled();
  });
});
