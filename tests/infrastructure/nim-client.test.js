import { describe, it, expect, vi } from 'vitest';
import { createNimClient } from '../../src/infrastructure/nim-client.js';

describe('createNimClient with per-model config', () => {
  it('uses per-model maxRetries and retryDelays', async () => {
    const resolver = {
      resolve: (model, key) => {
        if (model === 'glm-5.1' && key === 'maxRetries') return 1;
        if (model === 'glm-5.1' && key === 'retryDelays') return [0.001];
        return undefined;
      },
      getMatchedOverrides: () => null,
    };
    
    const authLoader = { getApiKey: async () => 'test-key' };
    const modelInjector = { patch: (m, b) => b };
    
    const client = createNimClient(
      { upstream: 'https://example.com', maxRetries: 3, retryDelays: [10, 20, 30] },
      authLoader, modelInjector, null, resolver
    );
    
    // Verify the resolver is called with the model
    const resolveSpy = vi.spyOn(resolver, 'resolve');
    
    // Mock fetch: first call returns 429, second returns 200
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          status: 429,
          headers: new Map([['content-type', 'application/json']]),
          body: null,
        });
      }
      return Promise.resolve({
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        body: null,
        arrayBuffer: async () => new ArrayBuffer(0),
      });
    });
    
    await client.send({ method: 'POST', path: '/chat/completions', body: { model: 'glm-5.1' }, headers: {} });
    
    expect(resolveSpy).toHaveBeenCalledWith('glm-5.1', 'maxRetries');
    expect(resolveSpy).toHaveBeenCalledWith('glm-5.1', 'retryDelays');
  });
});
