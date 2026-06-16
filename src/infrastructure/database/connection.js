import DatabaseClient from 'better-sqlite3';

const VALID_TABLES = new Set([
  '_schema_version', 'requests', 'throttle_events', 'throttle_state',
]);

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

  ensureInfrastructure() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS _migration_lock (
        id        INTEGER PRIMARY KEY CHECK (id = 1),
        locked_at INTEGER NOT NULL,
        hostname  TEXT NOT NULL DEFAULT '',
        pid       INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  close() {
    if (!this.db.open) return;
    this.db.close();
  }

  transaction(fn) {
    const txn = this.db.transaction(fn);
    return txn();
  }

  insertBatch(table, columns, rows) {
    if (rows.length === 0) return;
    if (!VALID_TABLES.has(table)) {
      throw new Error(`Invalid table name: ${table}`);
    }
    const placeholders = rows
      .map(() => `(${columns.map(() => '?').join(',')})`)
      .join(',');
    const stmt = this.db.prepare(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders}`
    );
    return stmt.run(...rows.flat());
  }
}
