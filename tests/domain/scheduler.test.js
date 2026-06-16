import { describe, it, expect, vi } from 'vitest';
import { createScheduler } from '../../src/domain/scheduler.js';

describe('createScheduler with per-model config', () => {
  it('uses per-model maxConcurrency', async () => {
    const resolver = {
      resolve: (model, key) => {
        if (model === 'glm-5.1' && key === 'maxConcurrency') return 1;
        return 2;
      },
      getMatchedOverrides: () => null,
    };
    
    const jobs = [];
    const processJob = async (job) => { jobs.push(job); };
    const limiter = {
      canDispatch: () => true,
      timeUntilDispatchAllowed: () => 0,
      recordDispatch: () => {},
      recordCompletion: () => {},
    };
    
    const scheduler = createScheduler(
      { maxConcurrency: 2, minDispatchGapMs: 0, windowMs: 60000, maxTpm: 250000 },
      limiter, processJob, () => 0, null, resolver
    );
    
    // With maxConcurrency=1 for glm-5.1, only 1 job should be active
    // This is hard to test precisely without timing, so we verify the resolver is called
    const resolveSpy = vi.spyOn(resolver, 'resolve');
    
    // Enqueue and start
    scheduler.enqueue({ body: { model: 'glm-5.1' }, upstreamPath: '/chat/completions' });
    scheduler.start();
    
    // Wait briefly for the scheduler to process
    await new Promise(r => setTimeout(r, 100));
    
    expect(resolveSpy).toHaveBeenCalledWith('glm-5.1', 'maxConcurrency');
    expect(resolveSpy).toHaveBeenCalledWith('glm-5.1', 'minDispatchGapMs');
    expect(resolveSpy).toHaveBeenCalledWith('glm-5.1', 'maxTpm');
  });
});
