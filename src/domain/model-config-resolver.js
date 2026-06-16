export function createModelConfigResolver(globalConfig) {
  const overrides = (globalConfig.models || []).map(m => ({
    pattern: m.pattern,
    overrides: m.config || {},
  }));

  function resolve(model, key) {
    if (!model) return globalConfig[key];
    for (const o of overrides) {
      if (o.pattern.test(model)) {
        if (o.overrides[key] !== undefined) return o.overrides[key];
      }
    }
    return globalConfig[key];
  }

  function getMatchedOverrides(model) {
    if (!model) return null;
    for (const o of overrides) {
      if (o.pattern.test(model)) return o.overrides;
    }
    return null;
  }

  return { resolve, getMatchedOverrides };
}
