import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../../src/infrastructure/database/connection.js';
import { createSnowflakeGenerator } from '../../../src/infrastructure/database/snowflake.js';
import { RequestsRepository } from '../../../src/infrastructure/database/requests-repository.js';

describe('RequestsRepository', () => {
  let db;
  let repo;
  let snowflake;

  beforeEach(() => {
    db = new Database(':memory:');
    db.migrate();
    snowflake = createSnowflakeGenerator({ workerId: 0 });
    repo = new RequestsRepository(db, snowflake);
  });

  afterEach(() => {
    db.close();
  });

  it('inserts a request and returns Snowflake id', () => {
    const id = repo.insert({
      model: 'test-model',
      promptTokens: 50n,
      completionTokens: 100n,
      totalTokens: 150n,
      tokenSource: 'estimated',
      createdAt: Date.now(),
    });

    expect(typeof id).toBe('bigint');
    expect(id > 0n).toBe(true);
  });

  it('inserts a batch of requests', () => {
    const ids = repo.insertBatch([
      { model: 'a', promptTokens: 10n, completionTokens: 20n, totalTokens: 30n, tokenSource: 'estimated', createdAt: Date.now() },
      { model: 'b', promptTokens: 20n, completionTokens: 40n, totalTokens: 60n, tokenSource: 'nim', createdAt: Date.now() },
    ]);

    expect(ids.length).toBe(2);
    expect(typeof ids[0]).toBe('bigint');
    expect(typeof ids[1]).toBe('bigint');

    const count = db.connection
      .prepare('SELECT COUNT(*) as c FROM requests')
      .get().c;
    expect(count).toBe(2n);
  });

  it('finds all fields stored correctly', () => {
    const createdAt = Date.now();
    repo.insert({
      model: 'test-model',
      statusCode: 200n,
      latencyMs: 1500n,
      error: null,
      promptTokens: 50n,
      completionTokens: 100n,
      totalTokens: 150n,
      tokenSource: 'nim',
      modelInjection: 'glm-thinking',
      isSse: true,
      createdAt,
    });

    const row = db.connection
      .prepare('SELECT * FROM requests')
      .get();

    expect(row.model).toBe('test-model');
    expect(row.status_code).toBe(200n);
    expect(row.latency_ms).toBe(1500n);
    expect(row.error).toBeNull();
    expect(row.prompt_tokens).toBe(50n);
    expect(row.completion_tokens).toBe(100n);
    expect(row.total_tokens).toBe(150n);
    expect(row.token_source).toBe('nim');
    expect(row.model_injection).toBe('glm-thinking');
    expect(row.is_sse).toBe(1n);
    expect(row.created_at).toBe(BigInt(createdAt));
  });

  it('counts total requests', () => {
    expect(repo.count()).toBe(0);

    repo.insert({ model: 'a', promptTokens: 0n, completionTokens: 0n, totalTokens: 0n, tokenSource: 'estimated', createdAt: Date.now() });
    repo.insert({ model: 'b', promptTokens: 0n, completionTokens: 0n, totalTokens: 0n, tokenSource: 'estimated', createdAt: Date.now() });

    expect(repo.count()).toBe(2);
  });

  it('finds by model with pagination', () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      repo.insert({ model: 'model-a', promptTokens: 0n, completionTokens: 0n, totalTokens: 0n, tokenSource: 'estimated', createdAt: now + i });
    }
    for (let i = 0; i < 5; i++) {
      repo.insert({ model: 'model-b', promptTokens: 0n, completionTokens: 0n, totalTokens: 0n, tokenSource: 'estimated', createdAt: now + i });
    }

    const resultsA = repo.findByModel('model-a', { limit: 3, offset: 0 });
    expect(resultsA.length).toBe(3);
    resultsA.forEach(r => expect(r.model).toBe('model-a'));

    const resultsApage2 = repo.findByModel('model-a', { limit: 3, offset: 3 });
    expect(resultsApage2.length).toBe(3);

    const resultsB = repo.findByModel('model-b');
    expect(resultsB.length).toBe(5);
  });

  it('gets token usage by model within time range', () => {
    const now = Date.now();
    repo.insert({ model: 'a', promptTokens: 10n, completionTokens: 20n, totalTokens: 30n, tokenSource: 'estimated', createdAt: now - 2000 });
    repo.insert({ model: 'a', promptTokens: 5n, completionTokens: 15n, totalTokens: 20n, tokenSource: 'estimated', createdAt: now - 1000 });
    repo.insert({ model: 'b', promptTokens: 100n, completionTokens: 200n, totalTokens: 300n, tokenSource: 'estimated', createdAt: now });

    const usage = repo.getTokenUsageByModel({ from: now - 1500, to: now + 1000 });
    expect(usage.length).toBe(2);
    const modelA = usage.find(u => u.model === 'a');
    expect(modelA.totalTokens).toBe(20);
    expect(modelA.requestCount).toBe(1);

    const modelB = usage.find(u => u.model === 'b');
    expect(modelB.totalTokens).toBe(300);
  });

  it('gets summary', () => {
    const now = Date.now();
    repo.insert({ model: 'a', statusCode: 200n, latencyMs: 100n, error: null, promptTokens: 10n, completionTokens: 20n, totalTokens: 30n, tokenSource: 'estimated', createdAt: now - 1000 });
    repo.insert({ model: 'a', statusCode: 200n, latencyMs: 200n, error: null, promptTokens: 5n, completionTokens: 15n, totalTokens: 20n, tokenSource: 'estimated', createdAt: now });
    repo.insert({ model: 'b', statusCode: 500n, latencyMs: 3000n, error: 'timeout', promptTokens: 0n, completionTokens: 0n, totalTokens: 0n, tokenSource: 'estimated', createdAt: now });

    const summary = repo.getSummary({ from: now - 2000, to: now + 1000 });
    expect(summary.totalRequests).toBe(3);
    expect(summary.totalTokens).toBe(50);
    expect(summary.avgLatencyMs).toBeCloseTo(1100, 0);
    expect(summary.errorCount).toBe(1);
  });

  it('prunes records older than timestamp', () => {
    const now = Date.now();
    repo.insert({ model: 'old', promptTokens: 0n, completionTokens: 0n, totalTokens: 0n, tokenSource: 'estimated', createdAt: now - 100000 });
    repo.insert({ model: 'new', promptTokens: 0n, completionTokens: 0n, totalTokens: 0n, tokenSource: 'estimated', createdAt: now });

    const deleted = repo.prune(now - 50000);
    expect(deleted).toBe(1);
    expect(repo.count()).toBe(1);
  });
});
