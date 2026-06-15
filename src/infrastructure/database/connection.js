import DatabaseClient from 'better-sqlite3';

export class Database {
  constructor(path) {
    this.path = path;
    this.db = new DatabaseClient(path);
    this.db.defaultSafeIntegers(true);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('cache_size = -64000');
    this.db.pragma('foreign_keys = ON');
  }

  get connection() {
    return this.db;
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);

    const currentVersion = this.db
      .prepare('SELECT COALESCE(MAX(version), 0) as v FROM _schema_version')
      .get().v;

    if (currentVersion < 1) {
      this.db.exec(`
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

      this.db.prepare(
        'INSERT INTO _schema_version (version, applied_at) VALUES (1, ?)'
      ).run(Date.now());
    }
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    const txn = this.db.transaction(fn);
    return txn();
  }

  insertBatch(table, columns, rows) {
    if (rows.length === 0) return;
    const placeholders = rows
      .map(() => `(${columns.map(() => '?').join(',')})`)
      .join(',');
    const stmt = this.db.prepare(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders}`
    );
    return stmt.run(...rows.flat());
  }
}
