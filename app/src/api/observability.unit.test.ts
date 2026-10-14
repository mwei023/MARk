import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventVisibleToSession, toBusEventFrame } from './observability.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('observability APIs (real bus projections)', () => {
  it('keeps user command frames inside their interaction session', () => {
    const event = {
      id: 'CMD-1', timestamp: new Date(), source: 'user_command',
      type: 'user.command.received', severity: 'info',
      data: { command: 'private command', sessionId: 'alice' },
    } as any;
    expect(eventVisibleToSession(event, 'alice')).toBe(true);
    expect(eventVisibleToSession(event, 'bob')).toBe(false);
    expect(eventVisibleToSession({ ...event, type: 'github.workflow.failed' }, 'bob')).toBe(true);
  });

  it('frames carry the real event field-for-field (no invented data)', () => {
    const frame = toBusEventFrame({
      id: 'EVT-1',
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
      source: 'github',
      type: 'github.workflow.failed',
      severity: 'warning',
      correlationId: 'org/repo',
      data: { repository: 'org/repo' },
    } as never);
    expect(frame).toEqual({
      id: 'EVT-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      source: 'github',
      type: 'github.workflow.failed',
      severity: 'warning',
      correlationId: 'org/repo',
      data: { repository: 'org/repo' },
    });
  });

  it('server wires the observability module once (routes live beside the bus)', () => {
    const server = readFileSync(join(here, 'server-v2.ts'), 'utf8');
    expect(server).toContain('registerObservabilityRoutes(app)');
    // server-v2 must not re-register these paths itself — one owner each.
    for (const route of ['/api/events/stream', '/api/interactions', '/api/kernel/status', '/api/kernel/tools']) {
      expect(server.includes(`app.get('${route}'`)).toBe(false);
    }
    const module = readFileSync(join(here, 'observability.ts'), 'utf8');
    for (const route of ['/api/events/stream', '/api/interactions', '/api/kernel/status', '/api/kernel/tools']) {
      expect(module).toContain(route);
    }
  });

  it('serves the UI bundle (control room + playground share one client)', () => {
    const source = readFileSync(join(here, 'server-v2.ts'), 'utf8');
    expect(source).toContain("express.static");
    expect(source).toContain("mark-os-site");
  });
});
