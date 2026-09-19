/**
 * Interaction core unit tests — stream, thinking toggle, redaction.
 * No DB, no LLM, no filesystem.
 */
import { describe, it, expect } from 'vitest';
import { InteractionStream, redactSecrets } from './interaction.js';

describe('redactSecrets', () => {
  it('redacts Groq keys', () => {
    const { text, redacted } = redactSecrets('key=gsk_abc123XYZ rest');
    expect(redacted).toBe(true);
    expect(text).not.toContain('gsk_abc123XYZ');
    expect(text).toContain('[REDACTED]');
  });

  it('redacts OpenRouter keys', () => {
    const { text, redacted } = redactSecrets('token sk-or-v1-abc123 rest');
    expect(redacted).toBe(true);
    expect(text).not.toContain('sk-or-v1-abc123');
  });

  it('redacts GitHub tokens', () => {
    const { text, redacted } = redactSecrets('ghp_secrettoken123');
    expect(redacted).toBe(true);
    expect(text).not.toContain('ghp_secrettoken123');
  });

  it('leaves clean text alone', () => {
    const { text, redacted } = redactSecrets('route=agent agent=git-agent llm=false');
    expect(redacted).toBe(false);
    expect(text).toContain('git-agent');
  });
});

describe('InteractionStream', () => {
  it('appends and lists in order', () => {
    const s = new InteractionStream();
    s.append('message', 'mwei', 'check git status');
    s.append('receipt', 'agent', 'done');
    const list = s.list();
    expect(list).toHaveLength(2);
    expect(list[0].kind).toBe('message');
    expect(list[1].kind).toBe('receipt');
  });

  it('hides thinking when toggled off, shows compact when on', () => {
    const s = new InteractionStream();
    s.append('thinking', 'gateway', '', {
      thinking: { source: 'classifier', compact: 'route=agent agent=git-agent', detail: 'long reasoning here' },
    });
    expect(s.renderText().join('\n')).not.toContain('git-agent');
    s.setThinking(true);
    expect(s.isThinkingOn()).toBe(true);
    expect(s.renderText().join('\n')).toContain('git-agent');
  });

  it('redacts thinking payloads on append (no toggle bypass)', () => {
    const s = new InteractionStream({ thinkingOn: true });
    s.append('thinking', 'gateway', '', {
      thinking: { source: 'llm', compact: 'using key gsk_abc123XYZ', detail: 'token sk-or-v1-abc123' },
    });
    const rendered = s.renderText({ expandThinking: true }).join('\n');
    expect(rendered).not.toContain('gsk_abc123XYZ');
    expect(rendered).not.toContain('sk-or-v1-abc123');
  });

  it('renders approval options inline', () => {
    const s = new InteractionStream();
    s.append('approval', 'kernel', '', {
      approval: { confirmationId: 'confirm_1', toolId: 'fs.file_write', reason: 'mutating', options: ['once', 'always', 'root'] },
    });
    const out = s.renderText().join('\n');
    expect(out).toContain('confirm_1');
    expect(out).toContain('always');
    expect(out).toContain('root');
    expect(s.pendingApprovals()).toHaveLength(1);
  });

  it('trims to maxEvents', () => {
    const s = new InteractionStream({ maxEvents: 3 });
    for (let i = 0; i < 5; i++) s.append('trace', 'x', `line ${i}`);
    expect(s.list()).toHaveLength(3);
    expect(s.list()[0].text).toBe('line 2');
  });
});
