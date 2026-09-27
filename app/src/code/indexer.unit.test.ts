import { describe, it, expect } from 'vitest';
import { chunkCode } from './indexer.js';

describe('code chunking', () => {
  it('annotates chunks with enclosing symbols', () => {
    const content = [
      'export function alpha() {', '  return 1;', '}',
      ...Array.from({ length: 120 }, (_, i) => `// filler ${i}`),
      'export class Beta {', '  run() {}', '}',
    ].join('\n');
    const chunks = chunkCode(content, 'a.ts');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].symbol).toMatch(/alpha/);
    const last = chunks[chunks.length - 1];
    expect(last.symbol).toMatch(/Beta/);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(8000);
  });

  it('handles symbol-free files', () => {
    const chunks = chunkCode('just\nsome\ntext', 'notes.txt');
    expect(chunks.length).toBe(1);
    expect(chunks[0].symbol).toBe('');
  });
});
