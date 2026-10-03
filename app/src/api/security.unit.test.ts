import { describe, it, expect } from 'vitest';
import { resolveApiSecurity } from './security.js';

describe('API security boundary', () => {
  it('defaults to loopback bind', () => {
    const r = resolveApiSecurity({});
    expect(r.bindHost).toBe('127.0.0.1');
    expect(r.fatal).toBeUndefined();
  });

  it('honours an explicit bind host but warns on non-loopback', () => {
    const local = resolveApiSecurity({ bindHost: '::1', apiToken: 'x', githubWebhookSecret: 'shh' });
    expect(local.bindHost).toBe('::1');
    expect(local.warnings).toHaveLength(0);

    const wide = resolveApiSecurity({ bindHost: '0.0.0.0', apiToken: 'x' });
    expect(wide.bindHost).toBe('0.0.0.0');
    expect(wide.warnings.some(w => w.includes('non-loopback'))).toBe(true);
  });

  it('refuses production boot with an open API', () => {
    const r = resolveApiSecurity({ nodeEnv: 'production' });
    expect(r.authMode).toBe('open');
    expect(r.fatal).toContain('Refusing to start');
  });

  it('production with a token boots clean apart from webhook-secret advice', () => {
    const r = resolveApiSecurity({ nodeEnv: 'production', apiToken: 's3cret', githubWebhookSecret: 'shh' });
    expect(r.fatal).toBeUndefined();
    expect(r.authMode).toBe('token');
    expect(r.warnings).toHaveLength(0);
  });

  it('explicit escape hatch allows open API in production with a loud warning', () => {
    const r = resolveApiSecurity({ nodeEnv: 'production', allowUnauthenticatedApi: true });
    expect(r.fatal).toBeUndefined();
    expect(r.authMode).toBe('open');
    expect(r.warnings.some(w => w.includes('escape hatch'))).toBe(true);
  });

  it('dev without a token stays open with a local-first warning (back-compat)', () => {
    const r = resolveApiSecurity({ nodeEnv: 'development' });
    expect(r.fatal).toBeUndefined();
    expect(r.authMode).toBe('open');
    expect(r.warnings.some(w => w.includes('local-first'))).toBe(true);
  });

  it('missing webhook secret always warns', () => {
    const r = resolveApiSecurity({ apiToken: 'x' });
    expect(r.warnings.some(w => w.includes('GITHUB_WEBHOOK_SECRET'))).toBe(true);
  });
});
