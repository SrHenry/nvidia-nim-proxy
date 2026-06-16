export const version = 1781621796372000000n;
export const description = 'create model_throttle_state table';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_throttle_state (
      model            TEXT PRIMARY KEY,
      token_timestamps TEXT NOT NULL DEFAULT '[]',
      pending_tokens   INTEGER NOT NULL DEFAULT 0,
      updated_at       INTEGER NOT NULL
    );
  `);
}

export function down(db) {
  db.exec(`
    DROP TABLE IF EXISTS model_throttle_state;
  `);
}
