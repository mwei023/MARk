import { describe, it, expect, beforeEach } from 'vitest';
import {
  worldPerceptionTools,
  worldPerceptionImplementations,
} from './providers/world-perception.js';
import { clearWorldModel, recordSnapshot, renderWorldModel } from '../world/model.js';

function impl(id: string) {
  const found = worldPerceptionImplementations.find(i => i.toolId === id);
  if (!found) throw new Error(`missing impl ${id}`);
  return found;
}

beforeEach(() => clearWorldModel());

describe('world model fusion', () => {
  it('discovers quakes + snapshot as read tools', () => {
    const ids = worldPerceptionTools.map(t => t.id);
    expect(ids).toEqual(['world.quakes', 'world.snapshot']);
    for (const t of worldPerceptionTools) expect(t.risk).toBe('read');
  });

  it('empty scene reports honestly', async () => {
    const out: any = (await impl('world.snapshot').execute({ action: { input: {} } } as any)).output;
    expect(out.ok).toBe(true);
    expect(out.reported).toBe(0);
    expect(out.scene).toMatch(/empty/i);
  });

  it('unknown domain reports honestly', async () => {
    const out: any = (await impl('world.snapshot').execute({ action: { input: { domain: 'network' } } } as any)).output;
    expect(out.ok).toBe(true);
    expect(out.reported).toBe(false);
  });

  it('recorded snapshots render into one scene', () => {
    recordSnapshot({
      domain: 'repository', updatedAt: new Date().toISOString(), source: 'test',
      summary: '2 repos healthy', counts: { repos: 2 }, items: [],
    });
    expect(renderWorldModel()).toMatch(/\[repository\] 2 repos healthy/);
  });

  it('live USGS feed fuses or fails closed (never throws)', async () => {
    const out: any = (await impl('world.quakes').execute({ action: { input: { minMagnitude: 4.5, limit: 5 } } } as any)).output;
    expect(typeof out.ok).toBe('boolean');
    if (out.ok) {
      expect(out.summary).toBeTruthy();
      const snap: any = (await impl('world.snapshot').execute({ action: { input: { domain: 'world' } } } as any)).output;
      expect(snap.reported).toBe(true);
    } else {
      expect(out.reason).toBeTruthy();
    }
  }, 30000);
});
