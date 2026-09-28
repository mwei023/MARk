import { describe, it, expect } from 'vitest';
import { parseVisionVerdict } from './screen-agent.js';

describe('parseVisionVerdict (shared cloud/local contract)', () => {
  it('parses a full verdict with action', () => {
    const v = parseVisionVerdict('{"observation": "terminal open", "done": false, "action": {"tool": "screen.click", "input": {"x": 100, "y": 200}}, "reason": "focus it"}');
    expect(v.observation).toBe('terminal open');
    expect(v.done).toBe(false);
    expect(v.action).toEqual({ tool: 'screen.click', input: { x: 100, y: 200 } });
  });

  it('tolerates prose around the JSON and null actions', () => {
    const v = parseVisionVerdict('Here you go:\n{"observation": "done view", "done": true, "action": null, "reason": "complete"}\nbye');
    expect(v.done).toBe(true);
    expect(v.action).toBeNull();
  });

  it('fails closed on non-JSON', () => {
    expect(() => parseVisionVerdict('no json here')).toThrow(/no JSON/);
    expect(() => parseVisionVerdict('')).toThrow();
  });
});
