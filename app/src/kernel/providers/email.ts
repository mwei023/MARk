/**
 * Email provider (email.*): IMAP inbox reading + SMTP sending.
 *
 * Credentials are operator configuration ONLY (MARK_IMAP_* / MARK_SMTP_*
 * env vars) — goals never carry passwords, and failures name the missing
 * variable without ever printing a value. Without credentials every tool
 * fails closed with setup guidance. Sending is risk-mutating (denied by
 * default, confirmation-gated on workspace); reading is risk-read.
 */
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import {
  DiscoveryProvider,
  ToolDescriptor,
  ToolImplementation,
  ToolParameterSchema,
} from '../index';

const LIST_MAX = 20;
const BODY_MAX = 10000;
const ADDR_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const MAILBOX_RE = /^[A-Za-z0-9_.-]+$/;

function failOutput(reason: string): Record<string, unknown> {
  return { ok: false, reason: reason.slice(0, 300), capturedAt: new Date().toISOString() };
}

interface ImapConf { host: string; port: number; user: string; pass: string }
interface SmtpConf extends ImapConf { secure: boolean }

/** Read config without ever exposing values. Throws naming the missing var. */
function imapConf(): ImapConf {
  const host = (process.env.MARK_IMAP_HOST ?? '').trim();
  const user = (process.env.MARK_IMAP_USER ?? '').trim();
  const pass = process.env.MARK_IMAP_PASS ?? '';
  if (!host) throw new Error('Email is not configured: set MARK_IMAP_HOST (plus MARK_IMAP_USER/MARK_IMAP_PASS).');
  if (!user || !pass) throw new Error('Email is not configured: set MARK_IMAP_USER and MARK_IMAP_PASS.');
  const port = Number(process.env.MARK_IMAP_PORT ?? '993');
  return { host, port: Number.isFinite(port) ? port : 993, user, pass };
}

function smtpConf(): SmtpConf {
  const host = (process.env.MARK_SMTP_HOST ?? '').trim();
  const user = (process.env.MARK_SMTP_USER ?? '').trim();
  const pass = process.env.MARK_SMTP_PASS ?? '';
  if (!host) throw new Error('Email sending is not configured: set MARK_SMTP_HOST (plus MARK_SMTP_USER/MARK_SMTP_PASS).');
  if (!user || !pass) throw new Error('Email sending is not configured: set MARK_SMTP_USER and MARK_SMTP_PASS.');
  const port = Number(process.env.MARK_SMTP_PORT ?? '465');
  const secure = (process.env.MARK_SMTP_SECURE ?? 'true').toLowerCase() !== 'false';
  return { host, port: Number.isFinite(port) ? port : 465, user, pass, secure };
}

function checkMailbox(m: unknown): string {
  const v = String(m ?? 'INBOX').trim() || 'INBOX';
  if (!MAILBOX_RE.test(v) || v.length > 64) throw new Error('Refused: invalid mailbox name.');
  return v;
}

function checkLimit(l: unknown): number {
  if (l === undefined || l === null || String(l).trim() === '') return 10;
  const v = typeof l === 'number' ? l : Number(String(l).trim());
  if (!Number.isFinite(v)) return 10;
  return Math.min(Math.max(Math.floor(v), 1), LIST_MAX);
}

function checkAddresses(value: unknown, what: string): string[] {
  const list = Array.isArray(value) ? value : [value];
  const out = list.map(a => String(a ?? '').trim()).filter(Boolean);
  if (out.length === 0 || out.length > 10) throw new Error(`Refused: ${what} needs 1-10 addresses.`);
  for (const a of out) {
    if (!ADDR_RE.test(a)) throw new Error(`Refused: invalid email address ${JSON.stringify(a).slice(0, 60)}.`);
  }
  return out;
}

async function withImap<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const c = imapConf();
  const client = new ImapFlow({
    host: c.host, port: c.port, secure: true,
    auth: { user: c.user, pass: c.pass },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try { await client.logout(); } catch { /* best effort */ }
  }
}

function addrText(addr: unknown): string {
  if (!addr) return '';
  if (typeof addr === 'string') return addr;
  if (Array.isArray(addr)) return addr.map(addrText).filter(Boolean).join(', ');
  if (typeof addr === 'object') {
    const o = addr as { name?: string; address?: string };
    return o.name ? `${o.name} <${o.address ?? ''}>` : (o.address ?? '');
  }
  return '';
}

export const emailInboxTool: ToolDescriptor = {
  id: 'email.inbox_list',
  name: 'List inbox mail',
  description:
    'Lists recent email headers with senders, subjects, and dates. Use to review unread mail and incoming messages.',
  version: '1.0.0', domain: 'email', risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      mailbox: { type: 'string', description: 'Mailbox name (default INBOX).' },
      limit: { type: 'number', description: 'Max messages (1-20, default 10).' },
      unreadOnly: { type: 'boolean', description: 'Only unread messages (default true).' },
    },
    required: [],
  },
  capabilities: ['email-reading', 'communication'],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'email.native',
};

export const emailInboxImplementation: ToolImplementation = {
  toolId: emailInboxTool.id,
  async execute({ action }) {
    try {
      const input = action.input as Record<string, unknown>;
      const mailbox = checkMailbox(input.mailbox);
      const limit = checkLimit(input.limit);
      const unreadOnly = input.unreadOnly !== false;
      const list = await withImap(async client => {
        const lock = await client.getMailboxLock(mailbox);
        try {
          const query = unreadOnly ? { seen: false } : { all: true };
          const out: Array<Record<string, unknown>> = [];
          for await (const msg of client.fetch(query, { envelope: true, internalDate: true, uid: true })) {
            out.push({
              uid: msg.uid,
              from: addrText((msg.envelope as any)?.from),
              subject: (msg.envelope as any)?.subject ?? '',
              date: msg.internalDate instanceof Date ? msg.internalDate.toISOString() : String(msg.internalDate ?? ''),
            });
            if (out.length >= 200) break;
          }
          return out.slice(-limit).reverse();
        } finally {
          lock.release();
        }
      });
      const output = { mailbox, count: list.length, messages: list, capturedAt: new Date().toISOString() };
      return {
        output,
        observations: [{
          id: `observation-${Date.now()}`, kind: 'output' as const, source: 'email.native', subject: mailbox,
          summary: `${list.length} message(s) in ${mailbox}.`,
          data: output, confidence: 1, observedAt: output.capturedAt, relatedResourceIds: [],
        }],
      };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

export const emailReadTool: ToolDescriptor = {
  id: 'email.read',
  name: 'Read email',
  description:
    'Reads one email body by id with sender, subject, and date. Use to read a specific message in full.',
  version: '1.0.0', domain: 'email', risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      uid: { type: 'number', description: 'Message id from email.inbox_list.' },
      mailbox: { type: 'string', description: 'Mailbox name (default INBOX).' },
    },
    required: ['uid'],
  },
  capabilities: ['email-reading', 'communication'],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'email.native',
};

export const emailReadImplementation: ToolImplementation = {
  toolId: emailReadTool.id,
  async execute({ action }) {
    try {
      const input = action.input as Record<string, unknown>;
      const uid = typeof input.uid === 'number' ? input.uid : Number(String(input.uid ?? '').trim());
      if (!Number.isInteger(uid) || uid <= 0) throw new Error('Refused: uid must be a positive integer.');
      const mailbox = checkMailbox(input.mailbox);
      const msg = await withImap(async client => {
        const lock = await client.getMailboxLock(mailbox);
        try {
          const fetched = await client.fetchOne(String(uid), { envelope: true, bodyParts: ['text'] as any });
          if (!fetched) throw new Error(`No message with id ${uid} in ${mailbox}.`);
          return fetched;
        } finally {
          lock.release();
        }
      });
      const part = (msg as any).bodyParts?.get?.('text') ?? (msg as any).bodyParts?.['text'];
      const raw = part ? Buffer.from(part as Uint8Array).toString('utf8') : '';
      const body = raw.length > BODY_MAX ? `${raw.slice(0, BODY_MAX)}\n… (truncated)` : raw;
      const output = {
        uid, mailbox, from: addrText((msg.envelope as any)?.from),
        subject: (msg.envelope as any)?.subject ?? '', date: (msg as any).internalDate?.toISOString?.() ?? '',
        body, capturedAt: new Date().toISOString(),
      };
      return {
        output,
        observations: [{
          id: `observation-${Date.now()}`, kind: 'output' as const, source: 'email.native', subject: `${mailbox}/${uid}`,
          summary: `Read message ${uid} (${String(output.subject).slice(0, 80)}).`,
          data: { ...output, body: body.slice(0, 300) }, confidence: 1,
          observedAt: output.capturedAt, relatedResourceIds: [],
        }],
      };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

export const emailSendTool: ToolDescriptor = {
  id: 'email.send',
  name: 'Send email',
  description:
    'Sends an email to recipients with a subject and body. Mutating: needs confirmation outside test mode.',
  version: '1.0.0', domain: 'email', risk: 'mutating',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email address.' },
      subject: { type: 'string', description: 'Subject line.' },
      body: { type: 'string', description: 'Plain-text body (max 10000 chars).' },
    },
    required: ['to', 'subject', 'body'],
  },
  capabilities: ['email-sending', 'communication'],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: false,
  metadata: {},
  provider: 'email.native',
};

export const emailSendImplementation: ToolImplementation = {
  toolId: emailSendTool.id,
  async execute({ action }) {
    try {
      const input = action.input as Record<string, unknown>;
      const to = checkAddresses(input.to, 'recipient');
      const subject = String(input.subject ?? '').trim().slice(0, 300);
      const body = String(input.body ?? '');
      if (!subject) throw new Error('Refused: subject is required.');
      if (!body.trim()) throw new Error('Refused: body is required.');
      if (body.length > BODY_MAX) throw new Error(`Refused: body exceeds ${BODY_MAX} chars.`);
      const c = smtpConf();
      const transporter = nodemailer.createTransport({
        host: c.host, port: c.port, secure: c.secure,
        auth: { user: c.user, pass: c.pass },
      });
      const info = await transporter.sendMail({ from: c.user, to: to.join(', '), subject, text: body });
      const output = { to, subject, messageId: String(info.messageId ?? ''), capturedAt: new Date().toISOString() };
      return {
        output,
        observations: [{
          id: `observation-${Date.now()}`, kind: 'output' as const, source: 'email.native', subject: to.join(','),
          summary: `Sent email to ${to.join(', ')} (confirmation granted).`,
          data: output, confidence: 1, observedAt: output.capturedAt, relatedResourceIds: [],
        }],
      };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

export const emailTools: ToolDescriptor[] = [emailInboxTool, emailReadTool, emailSendTool];
export const emailImplementations: ToolImplementation[] = [
  emailInboxImplementation, emailReadImplementation, emailSendImplementation,
];

export const emailDiscoveryProvider: DiscoveryProvider = {
  id: 'email.native',
  name: 'Email provider',
  description: 'Reads IMAP mailboxes and sends mail over SMTP (operator credentials required).',
  priority: 80,
  async isAvailable(): Promise<boolean> {
    return true;
  },
  async discoverResources(): Promise<never[]> {
    return [];
  },
  async discoverTools(): Promise<ToolDescriptor[]> {
    return emailTools;
  },
};
