export const version = 1781637840412443418n;
export const description = 'add model_cooldowns to throttle_state';

export function up(db) {
  db.exec(`
    ALTER TABLE throttle_state ADD COLUMN model_cooldowns TEXT NOT NULL DEFAULT '{}';
  `);
}

export function down(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS throttle_state_new (
      id             INTEGER PRIMARY KEY CHECK (id = 1),
      adaptive_limit INTEGER NOT NULL DEFAULT 25,
      cooldown_until INTEGER NOT NULL DEFAULT 0,
      updated_at     INTEGER NOT NULL
    );
    INSERT INTO throttle_state_new (id, adaptive_limit, cooldown_until, updated_at)
      SELECT id, adaptive_limit, cooldown_until, updated_at FROM throttle_state;
    DROP TABLE throttle_state;
    ALTER TABLE throttle_state_new RENAME TO throttle_state;
  `);
}
