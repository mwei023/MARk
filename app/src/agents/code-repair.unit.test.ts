import { describe, it, expect } from 'vitest';
import { formatSiblingContext } from '../agents/code-repair.js';
import type { LintError } from '../agents/code-repair.js';

const err = (file: string, line: number, ruleId = 'semi'): LintError => ({
  file, line, column: 1, ruleId, message: 'missing semicolon',
});

describe('coordinated repair context', () => {
  it('lists other errors in the same file only', () => {
    const out = formatSiblingContext(err('a.ts', 10), [err('a.ts', 20, 'quotes'), err('b.ts', 5), err('a.ts', 10)]);
    expect(out).toMatch(/line 20/);
    expect(out).toMatch(/quotes/);
    expect(out).not.toMatch(/b\.ts/);
    expect(out).not.toMatch(/line 10/);
  });

  it('returns empty with no siblings', () => {
    expect(formatSiblingContext(err('a.ts', 1), [])).toBe('');
    expect(formatSiblingContext(err('a.ts', 1))).toBe('');
  });

  it('caps at five siblings', () => {
    const sibs = Array.from({ length: 9 }, (_, i) => err('a.ts', i + 2));
    const lines = formatSiblingContext(err('a.ts', 1), sibs).split('\n').filter(l => l.startsWith('- line'));
    expect(lines.length).toBe(5);
  });
});
