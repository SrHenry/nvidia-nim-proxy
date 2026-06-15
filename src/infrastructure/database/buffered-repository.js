export class BufferedRepository {
  constructor(inner, opts = {}) {
    this.inner = inner;
    this.buffer = [];
    this.flushIntervalMs = opts.flushIntervalMs ?? 5000;
    this.batchSize = opts.batchSize ?? 100;
    this.flushTimer = null;
    this.pendingFlush = null;
    this._consecutiveFailures = 0;
  }

  insert(record) {
    this.buffer.push(record);
    if (this.buffer.length >= this.batchSize) {
      this.flush();
    }
    this._ensureTimer();
  }

  flush() {
    if (this.buffer.length === 0) return undefined;
    if (this.pendingFlush) return this.pendingFlush;

    const batch = this.buffer.splice(0);
    this.pendingFlush = Promise.resolve(this.inner.insertBatch(batch))
      .then(() => {
        this._consecutiveFailures = 0;
      })
      .catch((err) => {
        this._consecutiveFailures++;
        this.buffer.unshift(...batch);
        if (this._consecutiveFailures >= 3) {
          console.error(
            `[BufferedRepository] ${this._consecutiveFailures} consecutive flush failures — data in buffer may be lost`
          );
        }
      })
      .finally(() => {
        this.pendingFlush = null;
      });

    return this.pendingFlush;
  }

  _ensureTimer() {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }

  async drain() {
    clearInterval(this.flushTimer);
    this.flushTimer = null;
    if (this.pendingFlush) {
      await this.pendingFlush;
    }
    await this.flush();
  }

  destroy() {
    clearInterval(this.flushTimer);
    this.flushTimer = null;
  }

  // Direct pass-through for bulk operations (bypasses buffer)
  insertBatch(...args) { return this.inner.insertBatch(...args); }

  findByModel(...args) { return this.inner.findByModel(...args); }
  getTokenUsageByModel(...args) { return this.inner.getTokenUsageByModel(...args); }
  getSummary(...args) { return this.inner.getSummary(...args); }
  count(...args) { return this.inner.count(...args); }
  prune(...args) { return this.inner.prune(...args); }

  getState(...args) { return this.inner.getState?.(...args); }
  setState(...args) { return this.inner.setState?.(...args); }
  getRecentEvents(...args) { return this.inner.getRecentEvents?.(...args); }
  insertEvent(...args) { return this.inner.insertEvent?.(...args); }
}
