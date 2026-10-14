import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  emailInboxImplementation,
  emailReadImplementation,
  emailSendImplementation,
  emailTools,
} from './providers/email.js';

const VARS = ['MARK_IMAP_HOST', 'MARK_IMAP_USER', 'MARK_IMAP_PASS', 'MARK_SMTP_HOST', 'MARK_SMTP_USER', 'MARK_SMTP_PASS'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const v of VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
});

afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

const ctx = { workingDirectory: '/tmp', userId: 'test', source: 'system' } as any;
const act = (toolId: string, input: Record<string, unknown>) =>
  ({ id: 'ACT-test', toolId, input, requestedBy: 'test', createdAt: new Date().toISOString() }) as any;
const run = (impl: any, input: Record<string, unknown>) =>
  impl.execute({ action: act(impl.toolId, input), context: ctx }) as Promise<any>;

describe('email provider (offline: validation + no-creds degradation)', () => {
  it('exposes inbox/read/send with read/mutating split', () => {
    expect(emailTools.map(t => t.id)).toEqual(['email.inbox_list', 'email.read', 'email.send']);
    expect(emailTools.find(t => t.id === 'email.send')?.risk).toBe('mutating');
  });

  it('fails closed naming the missing var, never a value', async () => {
    const inbox: any = await run(emailInboxImplementation, {});
    expect(inbox.output.ok).toBe(false);
    expect(inbox.output.reason).toContain('MARK_IMAP_HOST');
    expect(inbox.output.reason).not.toContain('secret');
    const send: any = await run(emailSendImplementation, { to: 'a@b.com', subject: 's', body: 'b' });
    expect(send.output.ok).toBe(false);
    expect(send.output.reason).toContain('MARK_SMTP_HOST');
  });

  it('validates addresses, uids, mailboxes before touching the network', async () => {
    process.env.MARK_SMTP_HOST = 'smtp.example.com';
    process.env.MARK_SMTP_USER = 'u';
    process.env.MARK_SMTP_PASS = 'p';
    for (const input of [
      { to: 'not-an-email', subject: 's', body: 'b' },
      { to: 'a@b.com', subject: '', body: 'b' },
      { to: 'a@b.com', subject: 's', body: '   ' },
      { to: 'a@b.com', subject: 's', body: 'x'.repeat(10001) },
    ]) {
      const r: any = await run(emailSendImplementation, input);
      expect(r.output.ok).toBe(false);
    }
    process.env.MARK_IMAP_HOST = 'imap.example.com';
    process.env.MARK_IMAP_USER = 'u';
    process.env.MARK_IMAP_PASS = 'p';
    const bad: any = await run(emailReadImplementation, { uid: -2 });
    expect(bad.output.ok).toBe(false);
  });
});
