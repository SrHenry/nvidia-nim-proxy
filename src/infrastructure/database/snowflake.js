const DEFAULT_EPOCH = 1767225600000n;

export function createSnowflakeGenerator(opts = {}) {
  const workerId = BigInt(opts.workerId ?? 0) & 0x3FFn;
  const epoch = opts.epoch !== undefined ? BigInt(opts.epoch) : DEFAULT_EPOCH;

  let lastTimestamp = 0n;
  let sequence = 0n;

  function currentTimestamp() {
    return BigInt(Date.now());
  }

  function next() {
    let now = currentTimestamp() - epoch;

    if (now < lastTimestamp) {
      const diff = Number(lastTimestamp - now);
      throw new Error(
        `Clock moved backwards by ${diff}ms — refusing to generate ID`
      );
    }

    if (now === lastTimestamp) {
      sequence = (sequence + 1n) & 0xFFFn;
      if (sequence === 0n) {
        while (now === lastTimestamp) {
          now = currentTimestamp() - epoch;
        }
      }
    } else {
      sequence = 0n;
    }

    lastTimestamp = now;

    return (now << 22n) | (workerId << 12n) | sequence;
  }

  return { next };
}
