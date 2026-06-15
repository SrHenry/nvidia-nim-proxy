const INSERT_COLUMNS = [
  'id', 'model', 'status_code', 'latency_ms', 'error',
  'prompt_tokens', 'completion_tokens', 'total_tokens',
  'token_source', 'model_injection', 'is_sse', 'created_at',
];

function rowToObject(row) {
  return {
    id: row.id,
    model: row.model,
    statusCode: row.status_code,
    latencyMs: row.latency_ms,
    error: row.error,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    tokenSource: row.token_source,
    modelInjection: row.model_injection,
    isSse: Boolean(row.is_sse),
    createdAt: row.created_at,
  };
}

export class RequestsRepository {
  constructor(db, snowflake) {
    this.db = db;
    this.snowflake = snowflake;
  }

  insert(record) {
    const id = this.snowflake.next();
    const stmt = this.db.connection.prepare(`
      INSERT INTO requests (${INSERT_COLUMNS.join(',')})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      record.model ?? 'unknown',
      record.statusCode ?? null,
      record.latencyMs ?? null,
      record.error ?? null,
      record.promptTokens ?? 0n,
      record.completionTokens ?? 0n,
      record.totalTokens ?? 0n,
      record.tokenSource ?? 'estimated',
      record.modelInjection ?? null,
      record.isSse ? 1n : 0n,
      record.createdAt ?? Date.now()
    );
    return id;
  }

  insertBatch(records) {
    if (records.length === 0) return [];
    const rows = records.map((r) => [
      this.snowflake.next(),
      r.model ?? 'unknown',
      r.statusCode ?? null,
      r.latencyMs ?? null,
      r.error ?? null,
      r.promptTokens ?? 0n,
      r.completionTokens ?? 0n,
      r.totalTokens ?? 0n,
      r.tokenSource ?? 'estimated',
      r.modelInjection ?? null,
      r.isSse ? 1n : 0n,
      r.createdAt ?? Date.now(),
    ]);
    this.db.insertBatch('requests', INSERT_COLUMNS, rows);
    return rows.map((r) => r[0]);
  }

  findByModel(model, opts = {}) {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    let query = 'SELECT * FROM requests WHERE model = ?';
    const params = [model];

    if (opts.from) {
      query += ' AND created_at >= ?';
      params.push(opts.from);
    }
    if (opts.to) {
      query += ' AND created_at <= ?';
      params.push(opts.to);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return this.db.connection.prepare(query).all(...params).map(rowToObject);
  }

  getTokenUsageByModel({ from, to } = {}) {
    let query = `
      SELECT model,
             SUM(total_tokens) as total_tokens,
             COUNT(*) as request_count
      FROM requests
      WHERE 1=1
    `;
    const params = [];
    if (from) { query += ' AND created_at >= ?'; params.push(from); }
    if (to) { query += ' AND created_at <= ?'; params.push(to); }
    query += ' GROUP BY model ORDER BY total_tokens DESC';

    const rows = this.db.connection.prepare(query).all(...params);
    return rows.map((r) => ({
      model: r.model,
      totalTokens: Number(r.total_tokens),
      requestCount: Number(r.request_count),
    }));
  }

  getSummary({ from, to } = {}) {
    let query = `
      SELECT COUNT(*) as total_requests,
             COALESCE(SUM(total_tokens), 0) as total_tokens,
             COALESCE(ROUND(AVG(latency_ms)), 0) as avg_latency_ms,
             SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) as error_count
      FROM requests
      WHERE 1=1
    `;
    const params = [];
    if (from) { query += ' AND created_at >= ?'; params.push(from); }
    if (to) { query += ' AND created_at <= ?'; params.push(to); }

    const row = this.db.connection.prepare(query).get(...params);
    return {
      totalRequests: Number(row.total_requests),
      totalTokens: Number(row.total_tokens),
      avgLatencyMs: Number(row.avg_latency_ms),
      errorCount: Number(row.error_count),
    };
  }

  count() {
    const row = this.db.connection
      .prepare('SELECT COUNT(*) as c FROM requests')
      .get();
    return Number(row.c);
  }

  prune(beforeTimestamp) {
    const result = this.db.connection
      .prepare('DELETE FROM requests WHERE created_at < ?')
      .run(beforeTimestamp);
    return result.changes;
  }
}
