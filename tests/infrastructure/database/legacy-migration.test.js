import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Database } from '../../../src/infrastructure/database/connection.js';
import { createSnowflakeGenerator } from '../../../src/infrastructure/database/snowflake.js';
import { RequestsRepository } from '../../../src/infrastructure/database/requests-repository.js';
import { ThrottleRepository } from '../../../src/infrastructure/database/throttle-repository.js';
import { maybeMigrateFromJson } from '../../../src/infrastructure/database/legacy-migration.js';

describe('Legacy JSON migration', () => {
  let db;
  let requestsRepo;
  let throttleRepo;
  let snowflake;
  let jsonPath;

  beforeEach(() => {
    db = new Database(':memory:');
    db.migrate();
    snowflake = createSnowflakeGenerator({ workerId: 0 });
    requestsRepo = new RequestsRepository(db, snowflake);
    throttleRepo = new ThrottleRepository(db, snowflake);
    jsonPath = path.join(os.tmpdir(), `test-legacy-${Date.now()}.json`);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
    const migrated = jsonPath + '.migrated';
    if (fs.existsSync(migrated)) fs.unlinkSync(migrated);
  });

  it('does nothing if JSON file does not exist', async () => {
    await maybeMigrateFromJson('/nonexistent/path.json', requestsRepo, throttleRepo);
    expect(requestsRepo.count()).toBe(0);
  });

  it('migrates token usage entries', async () => {
    const now = Date.now();
    const legacy = {
      tokenUsage: [
        { ts: now - 10000, model: 'model-a', promptTokens: 50, completionTokens: 100, totalTokens: 150, source: 'nim' },
        { ts: now - 5000, model: 'model-b', promptTokens: 20, completionTokens: 30, totalTokens: 50, source: 'estimated' },
      ],
    };
    fs.writeFileSync(jsonPath, JSON.stringify(legacy));

    await maybeMigrateFromJson(jsonPath, requestsRepo, throttleRepo);
    expect(requestsRepo.count()).toBe(2);
    expect(fs.existsSync(jsonPath)).toBe(false);
    expect(fs.existsSync(jsonPath + '.migrated')).toBe(true);
  });

  it('migrates cooldown state', async () => {
    const now = Date.now();
    const legacy = {
      cooldownUntil: now + 3600000,
      adaptiveLimit: 23,
    };
    fs.writeFileSync(jsonPath, JSON.stringify(legacy));

    await maybeMigrateFromJson(jsonPath, requestsRepo, throttleRepo);
    const state = throttleRepo.getState();
    expect(state.adaptiveLimit).toBe(23);
    expect(state.cooldownUntil).toBe(now + 3600000);
  });

  it('handles empty legacy file', async () => {
    fs.writeFileSync(jsonPath, JSON.stringify({}));
    await maybeMigrateFromJson(jsonPath, requestsRepo, throttleRepo);
    expect(requestsRepo.count()).toBe(0);
  });

  it('is idempotent — .migrated files are not re-processed', async () => {
    fs.writeFileSync(jsonPath + '.migrated', '{}');
    const now = Date.now();
    fs.writeFileSync(jsonPath, JSON.stringify({
      tokenUsage: [{ ts: now, model: 'a', promptTokens: 1, completionTokens: 1, totalTokens: 2, source: 'estimated' }],
    }));

    await maybeMigrateFromJson(jsonPath, requestsRepo, throttleRepo);
    expect(requestsRepo.count()).toBe(1);
  });
});
