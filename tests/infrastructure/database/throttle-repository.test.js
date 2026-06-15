import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../../src/infrastructure/database/connection.js';
import { createSnowflakeGenerator } from '../../../src/infrastructure/database/snowflake.js';
import { ThrottleRepository } from '../../../src/infrastructure/database/throttle-repository.js';

describe('ThrottleRepository', () => {
  let db;
  let repo;
  let snowflake;

  beforeEach(() => {
    db = new Database(':memory:');
    db.migrate();
    snowflake = createSnowflakeGenerator({ workerId: 0 });
    repo = new ThrottleRepository(db, snowflake);
  });

  afterEach(() => {
    db.close();
  });

  it('gets default throttle state', () => {
    const state = repo.getState();
    expect(state).toBeDefined();
    expect(state.adaptiveLimit).toBe(25);
    expect(state.cooldownUntil).toBe(0);
  });

  it('sets and gets throttle state', () => {
    repo.setState({ adaptiveLimit: 20, cooldownUntil: 9999999999999 });
    const state = repo.getState();
    expect(state.adaptiveLimit).toBe(20);
    expect(state.cooldownUntil).toBe(9999999999999);
  });

  it('inserts and retrieves events', () => {
    const id = repo.insertEvent({
      type: 'cooldown_enter',
      limitBefore: 25,
      limitAfter: 24,
      cooldownUntil: 9999999999999,
      reason: '429 exhausted',
      metadata: JSON.stringify({ model: 'test', attempts: 4 }),
    });

    expect(typeof id).toBe('bigint');

    const events = repo.getRecentEvents(10);
    expect(events.length).toBe(1);
    expect(events[0].event_type).toBe('cooldown_enter');
    expect(events[0].limit_before).toBe(25n);
    expect(events[0].limit_after).toBe(24n);
  });

  it('returns empty array when no events', () => {
    const events = repo.getRecentEvents(10);
    expect(events).toEqual([]);
  });

  it('prunes events older than timestamp', () => {
    const now = Date.now();
    repo.insertEvent({ type: '429_retry', createdAt: now - 100000 });
    repo.insertEvent({ type: 'limit_decrement', createdAt: now });

    const deleted = repo.prune(now - 50000);
    expect(deleted).toBe(1);

    const remaining = repo.getRecentEvents(10);
    expect(remaining.length).toBe(1);
    expect(remaining[0].event_type).toBe('limit_decrement');
  });

  it('setState upserts without changing fields not provided', () => {
    repo.setState({ adaptiveLimit: 15 });
    const state = repo.getState();
    expect(state.adaptiveLimit).toBe(15);
    expect(state.cooldownUntil).toBe(0); // unchanged
  });

  it('creates throttle_state row if missing', () => {
    db.connection.prepare('DELETE FROM throttle_state').run();
    const state = repo.getState();
    expect(state).toBeDefined();
    expect(state.adaptiveLimit).toBe(25);
  });
});
