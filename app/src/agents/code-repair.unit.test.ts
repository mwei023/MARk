import { describe, it, expect } from 'vitest';
import { formatSiblingContext, tryRuleFix } from '../agents/code-repair.js';
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

describe('mechanical rule fixes', () => {
  const t = (ruleId: string, line: number, message = ''): LintError => ({ file: 'a.ts', line, column: 1, ruleId, message });

  it('deletes an unused simple declaration', () => {
    const src = 'export function f() {\n  const unused = 1;\n  return 2;\n}';
    const out = tryRuleFix(src, t('@typescript-eslint/no-unused-vars', 2, "'unused' is defined but never used"));
    expect(out).toBe('export function f() {\n  return 2;\n}');
  });

  it('refuses when the variable is used elsewhere', () => {
    const src = 'const used = 1;\nconsole.log(used);';
    expect(tryRuleFix(src, t('no-unused-vars', 1, "'used' is defined but never used"))).toBeNull();
  });

  it('refuses non whole-line declarations', () => {
    const src = 'const a = 1, b = 2;\nconsole.log(a);';
    expect(tryRuleFix(src, t('no-unused-vars', 1, "'b' is defined but never used"))).toBeNull();
  });

  it('converts let to const without reassignment', () => {
    const src = 'let x = 1;\nconsole.log(x);';
    const out = tryRuleFix(src, t('prefer-const', 1));
    expect(out).toBe('const x = 1;\nconsole.log(x);');
  });

  it('refuses let with reassignment', () => {
    const src = 'let x = 1;\nx = 2;';
    expect(tryRuleFix(src, t('prefer-const', 1))).toBeNull();
  });

  it('adds a missing semicolon', () => {
    expect(tryRuleFix('const x = 1', t('semi', 1))).toBe('const x = 1;');
  });

  it('leaves terminated lines and unknown rules alone', () => {
    expect(tryRuleFix('const x = 1;', t('semi', 1))).toBeNull();
    expect(tryRuleFix('const x = 1', t('no-explicit-any', 1))).toBeNull();
    expect(tryRuleFix('x', t('semi', 99))).toBeNull();
  });
});
