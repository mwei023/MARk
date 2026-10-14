import { describe, it, expect, afterEach } from 'vitest';
import { decideRoute, jevAvailable, JEV_MIN_CONFIDENCE } from './jev.js';

const OLD_KEY = process.env.JEV_API_KEY;

afterEach(() => {
  if (OLD_KEY === undefined) delete process.env.JEV_API_KEY;
  else process.env.JEV_API_KEY = OLD_KEY;
});

function stubFetch(body: unknown, ok = true, status = 200) {
  return (async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('jev routing brain', () => {
  it('returns undefined without a key (graceful, never throws)', async () => {
    delete process.env.JEV_API_KEY;
    expect(jevAvailable()).toBe(false);
    expect(await decideRoute('deploy to staging')).toBeUndefined();
  });

  it('maps a confident choice to a route', async () => {
    process.env.JEV_API_KEY = 'jv_live_test';
    const fetchFn = stubFetch({
      answers: {
        route: { type: 'choice', choice: 'agent:devops-agent', confidence: 0.91, probabilities: { 'agent:devops-agent': 0.91 } },
      },
    });
    const d = await decideRoute('ship it to staging', { fetchFn });
    expect(d?.route).toBe('agent:devops-agent');
    expect(d?.confidence).toBe(0.91);
  });

  it('rejects low confidence, unknown routes, and bad shapes', async () => {
    process.env.JEV_API_KEY = 'jv_live_test';
    expect(await decideRoute('x', {
      fetchFn: stubFetch({ answers: { route: { choice: 'kernel', confidence: JEV_MIN_CONFIDENCE - 0.1 } } }),
    })).toBeUndefined();
    expect(await decideRoute('x', {
      fetchFn: stubFetch({ answers: { route: { choice: 'teleport', confidence: 0.99 } } }),
    })).toBeUndefined();
    expect(await decideRoute('x', { fetchFn: stubFetch({ nope: 1 }) })).toBeUndefined();
  });

  it('treats HTTP errors and network failure as unavailable', async () => {
    process.env.JEV_API_KEY = 'jv_live_test';
    expect(await decideRoute('x', { fetchFn: stubFetch({}, false, 402) })).toBeUndefined();
    expect(await decideRoute('x', {
      fetchFn: (() => Promise.reject(new Error('down'))) as unknown as typeof fetch,
    })).toBeUndefined();
  });
});
