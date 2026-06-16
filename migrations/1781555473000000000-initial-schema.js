export const version = 1781555473000000000n;
export const description = 'create initial tables';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id                INTEGER PRIMARY KEY,
      model             TEXT NOT NULL,
      status_code       INTEGER,
      latency_ms        INTEGER,
      error             TEXT,
      prompt_tokens     INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens      INTEGER NOT NULL DEFAULT 0,
      token_source      TEXT NOT NULL DEFAULT 'estimated',
      model_injection   TEXT,
      is_sse            INTEGER NOT NULL DEFAULT 0,
      created_at        INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests(created_at);
    CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model);
    CREATE INDEX IF NOT EXISTS idx_requests_model_created ON requests(model, created_at);

    CREATE TABLE IF NOT EXISTS throttle_events (
      id             INTEGER PRIMARY KEY,
      event_type     TEXT NOT NULL,
      limit_before   INTEGER,
      limit_after    INTEGER,
      cooldown_until INTEGER,
      reason         TEXT,
      metadata       TEXT,
      created_at     INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_throttle_events_created ON throttle_events(created_at);

    CREATE TABLE IF NOT EXISTS throttle_state (
      id             INTEGER PRIMARY KEY CHECK (id = 1),
      adaptive_limit INTEGER NOT NULL DEFAULT 25,
      cooldown_until INTEGER NOT NULL DEFAULT 0,
      updated_at     INTEGER NOT NULL
    );

    INSERT OR IGNORE INTO throttle_state (id, adaptive_limit, cooldown_until, updated_at)
    VALUES (1, 25, 0, 0);
  `);
}

export function down(db) {
  db.exec(`
    DROP TABLE IF EXISTS requests;
    DROP TABLE IF EXISTS throttle_events;
    DROP TABLE IF EXISTS throttle_state;
  `);
}
