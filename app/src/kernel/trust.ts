import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TrustGrant {
  /** Exact tool id or id prefix (e.g. "desktop.open.vlc" or "desktop.open."). */
  pattern: string;
  grantedAt: string;
  grantedBy: string;
}

/**
 * Persistent auto-approve list for confirmation-gated tools.
 *
 * Trust only ever upgrades `require_confirmation` to an allow. Denied risk
 * levels stay denied no matter what is listed here, and every trusted
 * execution is still recorded as an observation naming the granting pattern.
 * Stored as JSON under the user's config dir so it survives restarts
 * (in-memory confirmations do not — approving a stale id from an earlier
 * session must fail loudly instead of hanging).
 */
export class TrustStore {
  private grants = new Map<string, TrustGrant>();
  private readonly file: string;

  constructor(file = path.join(os.homedir(), '.config', 'mark', 'trust.json')) {
    this.file = file;
    this.load();
  }

  /** The granting pattern, or undefined when the tool is not trusted. */
  isTrusted(toolId: string): TrustGrant | undefined {
    let best: TrustGrant | undefined;
    for (const grant of this.grants.values()) {
      if (toolId === grant.pattern || toolId.startsWith(grant.pattern)) {
        if (!best || grant.pattern.length > best.pattern.length) best = grant;
      }
    }
    return best;
  }

  trust(pattern: string, grantedBy = 'user'): TrustGrant {
    const grant: TrustGrant = {
      pattern: pattern.trim(),
      grantedAt: new Date().toISOString(),
      grantedBy,
    };
    if (!grant.pattern) throw new Error('Trust pattern is required.');
    this.grants.set(grant.pattern, grant);
    this.save();
    return grant;
  }

  untrust(pattern: string): boolean {
    const removed = this.grants.delete(pattern.trim());
    if (removed) this.save();
    return removed;
  }

  list(): TrustGrant[] {
    return Array.from(this.grants.values()).sort((a, b) => a.pattern.localeCompare(b.pattern));
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as { grants?: TrustGrant[] };
      for (const grant of parsed.grants ?? []) {
        if (grant?.pattern) this.grants.set(grant.pattern, grant);
      }
    } catch {
      // Missing or corrupt file: start empty, never crash startup.
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ grants: this.list() }, null, 2));
    } catch {
      // Best effort: a trusted tool simply asks again next session.
    }
  }
}

export const trustStore = new TrustStore();
