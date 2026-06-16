import { describe, it, expect } from 'vitest';
import { createModelConfigResolver } from '../../src/domain/model-config-resolver.js';

function makeConfig(overrides = []) {
  return {
    maxTpm: 250000,
    maxConcurrency: 2,
    cooldownMs: 3600000,
    models: overrides.map(o => ({ pattern: new RegExp(o.pattern, 'i'), override: o.config })),
  };
}

describe('createModelConfigResolver', () => {
  it('returns global default when no models configured', () => {
    const r = createModelConfigResolver(makeConfig());
    expect(r.resolve('any-model', 'maxTpm')).toBe(250000);
  });

  it('returns override when model matches pattern', () => {
    const r = createModelConfigResolver(makeConfig([
      { pattern: '^z-ai/glm', config: { maxTpm: 100000 } },
    ]));
    expect(r.resolve('z-ai/glm-5.1', 'maxTpm')).toBe(100000);
  });

  it('returns global default when model does not match any pattern', () => {
    const r = createModelConfigResolver(makeConfig([
      { pattern: '^z-ai/glm', config: { maxTpm: 100000 } },
    ]));
    expect(r.resolve('other-model', 'maxTpm')).toBe(250000);
  });

  it('returns override for multi-key config', () => {
    const r = createModelConfigResolver(makeConfig([
      { pattern: '^z-ai/glm', config: { maxTpm: 100000, maxConcurrency: 1 } },
    ]));
    expect(r.resolve('z-ai/glm-5.1', 'maxTpm')).toBe(100000);
    expect(r.resolve('z-ai/glm-5.1', 'maxConcurrency')).toBe(1);
    expect(r.resolve('z-ai/glm-5.1', 'cooldownMs')).toBe(3600000);
  });

  it('is case insensitive via i flag in pattern', () => {
    const r = createModelConfigResolver(makeConfig([
      { pattern: '^z-ai/glm', config: { maxTpm: 100000 } },
    ]));
    expect(r.resolve('Z-AI/GLM-5.1', 'maxTpm')).toBe(100000);
  });

  it('returns null from getMatchedOverrides when no match', () => {
    const r = createModelConfigResolver(makeConfig([
      { pattern: '^z-ai/glm', config: { maxTpm: 100000 } },
    ]));
    expect(r.getMatchedOverrides('other-model')).toBeNull();
  });

  it('returns override object from getMatchedOverrides on match', () => {
    const cfg = { maxTpm: 100000, cooldownMs: 600000 };
    const r = createModelConfigResolver(makeConfig([
      { pattern: '^z-ai/glm', config: cfg },
    ]));
    expect(r.getMatchedOverrides('z-ai/glm-5.1')).toEqual(cfg);
  });

  it('returns global default when model is null/undefined', () => {
    const r = createModelConfigResolver(makeConfig([
      { pattern: '^z-ai/glm', config: { maxTpm: 100000 } },
    ]));
    expect(r.resolve(null, 'maxTpm')).toBe(250000);
    expect(r.resolve(undefined, 'maxTpm')).toBe(250000);
  });

  it('first matching pattern wins', () => {
    const r = createModelConfigResolver(makeConfig([
      { pattern: '^z-ai', config: { maxTpm: 50000 } },
      { pattern: 'glm', config: { maxTpm: 100000 } },
    ]));
    expect(r.resolve('z-ai/glm-5.1', 'maxTpm')).toBe(50000);
  });
});
