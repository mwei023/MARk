import { describe, it, expect } from 'vitest';
import { decideTaskClass, keywordTaskClass, TASK_CLASSIFIER_VERSION } from './task-class.js';

function stubFetch(choice: string, confidence: number) {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ answers: { taskClass: { choice, confidence } } }),
  })) as unknown as typeof fetch;
}

describe('keyword task classes (offline)', () => {
  const cases: Array<[string, string]> = [
    ['rollback the production deploy', 'incident_recovery'],
    ['triage the overnight outage', 'incident_triage'],
    ['refactor the auth module into services', 'large_refactor'],
    ['fix the null crash in gateway tests', 'repo_bugfix'],
    ['map the dependency graph of app/src', 'repo_analysis'],
    ['diagnose why the machine is slow', 'system_diagnosis'],
    ['deep research vector databases', 'research'],
    ['run the backup script', 'shell_task'],
  ];
  for (const [goal, want] of cases) {
    it(`${JSON.stringify(goal)} -> ${want}`, () => {
      expect(keywordTaskClass(goal)?.taskClass).toBe(want);
    });
  }

  it('returns undefined for the genuinely ambiguous', () => {
    expect(keywordTaskClass('hello there')).toBeUndefined();
    expect(keywordTaskClass('')).toBeUndefined();
  });

  it('recovery verbs outrank triage nouns', () => {
    expect(keywordTaskClass('investigate the failed deploy then rollback')?.taskClass).toBe('incident_recovery');
  });
});

describe('decideTaskClass (Jev + fallback)', () => {
  it('uses Jev when keyed and confident', async () => {
    process.env.JEV_API_KEY = 'jv_live_test';
    try {
      const d = await decideTaskClass('migrate everything to postgres', { fetchFn: stubFetch('large_refactor', 0.9) });
      expect(d).toEqual({ taskClass: 'large_refactor', confidence: 0.9, source: 'jev' });
    } finally {
      delete process.env.JEV_API_KEY;
    }
  });

  it('falls back to keywords below confidence or without key', async () => {
    process.env.JEV_API_KEY = 'jv_live_test';
    try {
      const d = await decideTaskClass('fix the null crash in gateway tests', { fetchFn: stubFetch('research', 0.1) });
      expect(d?.taskClass).toBe('repo_bugfix');
      expect(d?.source).toBe('keyword');
    } finally {
      delete process.env.JEV_API_KEY;
    }
    expect(await decideTaskClass('fix the null crash in gateway tests')).toMatchObject({ source: 'keyword' });
  });

  it('rejects unknown choices and stays versioned', async () => {
    process.env.JEV_API_KEY = 'jv_live_test';
    try {
      expect(await decideTaskClass('fix it', { fetchFn: stubFetch('teleport', 0.99) })).toBeUndefined();
    } finally {
      delete process.env.JEV_API_KEY;
    }
    expect(TASK_CLASSIFIER_VERSION).toBe('tc-v1');
  });
});
