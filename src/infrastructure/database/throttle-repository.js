const EVENT_COLUMNS = [
  'id', 'event_type', 'limit_before', 'limit_after',
  'cooldown_until', 'reason', 'metadata', 'created_at',
];

export class ThrottleRepository {
  constructor(db, snowflake) {
    this.db = db;
    this.snowflake = snowflake;
  }

  getState() {
    let row = this.db.connection
      .prepare('SELECT * FROM throttle_state WHERE id = 1')
      .get();

    if (!row) {
      this.db.connection
        .prepare('INSERT OR IGNORE INTO throttle_state (id, adaptive_limit, cooldown_until, updated_at) VALUES (1, 25, 0, ?)')
        .run(Date.now());
      row = this.db.connection
        .prepare('SELECT * FROM throttle_state WHERE id = 1')
        .get();
    }

    return {
      adaptiveLimit: Number(row.adaptive_limit),
      cooldownUntil: Number(row.cooldown_until),
      updatedAt: Number(row.updated_at),
    };
  }

  setState(partial) {
    const current = this.getState();
    const adaptiveLimit = partial.adaptiveLimit ?? current.adaptiveLimit;
    const cooldownUntil = partial.cooldownUntil ?? current.cooldownUntil;
    const updatedAt = Date.now();

    this.db.connection
      .prepare(`
        INSERT INTO throttle_state (id, adaptive_limit, cooldown_until, updated_at)
        VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          adaptive_limit = excluded.adaptive_limit,
          cooldown_until = excluded.cooldown_until,
          updated_at = excluded.updated_at
      `)
      .run(adaptiveLimit, cooldownUntil, updatedAt);
  }

  insertEvent(event) {
    const id = this.snowflake.next();
    const stmt = this.db.connection.prepare(`
      INSERT INTO throttle_events (${EVENT_COLUMNS.join(',')})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      event.type,
      event.limitBefore ?? null,
      event.limitAfter ?? null,
      event.cooldownUntil ?? null,
      event.reason ?? null,
      event.metadata ?? null,
      event.createdAt ?? Date.now()
    );
    return id;
  }

  getRecentEvents(limit = 50) {
    return this.db.connection
      .prepare('SELECT * FROM throttle_events ORDER BY created_at DESC LIMIT ?')
      .all(limit);
  }

  prune(beforeTimestamp) {
    const result = this.db.connection
      .prepare('DELETE FROM throttle_events WHERE created_at < ?')
      .run(beforeTimestamp);
    return result.changes;
  }
}
