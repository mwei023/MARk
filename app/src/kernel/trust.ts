import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TrustGrant {
  /** Exact tool id or id prefix (e.g. "desktop.open.vlc" or "desktop.open."). */
  pattern: string;
  /**
   * Optional directory scope: the grant only applies when the execution
   * working directory is this path or inside it. Absent = all directories.
   */
  scopePath?: string;
  grantedAt: string;
  grantedBy: string;
}

export interface TrustStreak {
  toolId: string;
  /** Consecutive human-approved + successfully executed runs. */
  approvedStreak: number;
  updatedAt: string;
}

export interface TrustSuggestion {
  toolId: string;
  approvedStreak: number;
  reason: string;
}

/** True when the execution directory falls inside the granted scope. */
function withinScope(execDir: string | undefined, scope: string): boolean {
  if (!execDir) return false;
  const resolved = path.resolve(execDir);
  return resolved === scope || resolved.startsWith(scope + path.sep);
}

/** Consecutive approved successes before a tool is suggested for standing trust. */
export const TRUST_SUGGEST_THRESHOLD = 5;

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
  private streaks = new Map<string, TrustStreak>();
  private readonly file: string;

  constructor(file = path.join(os.homedir(), '.config', 'mark', 'trust.json')) {
    this.file = file;
    this.load();
  }

  /**
   * The granting pattern, or undefined when the tool is not trusted.
   * A scoped grant only matches when the execution working directory is
   * inside the grant's scope path ("allow in this project root").
   */
  isTrusted(toolId: string, scopePath?: string): TrustGrant | undefined {
    let best: TrustGrant | undefined;
    for (const grant of this.grants.values()) {
      if (toolId !== grant.pattern && !toolId.startsWith(grant.pattern)) continue;
      if (grant.scopePath && !withinScope(scopePath, grant.scopePath)) continue;
      if (!best || grant.pattern.length > best.pattern.length) best = grant;
    }
    return best;
  }

  trust(pattern: string, grantedBy = 'user', scopePath?: string): TrustGrant {
    const grant: TrustGrant = {
      pattern: pattern.trim(),
      grantedAt: new Date().toISOString(),
      grantedBy,
    };
    if (!grant.pattern) throw new Error('Trust pattern is required.');
    const scope = scopePath?.trim();
    if (scope) grant.scopePath = path.resolve(scope);
    // Key includes scope so the same tool can be trusted globally and
    // separately inside one project root.
    this.grants.set(`${grant.pattern}::${grant.scopePath ?? ''}`, grant);
    this.save();
    return grant;
  }

  untrust(pattern: string): boolean {
    const needle = pattern.trim();
    let removed = false;
    for (const key of Array.from(this.grants.keys())) {
      if (key === needle || key.startsWith(`${needle}::`)) {
        removed = this.grants.delete(key) || removed;
      }
    }
    if (removed) this.save();
    return removed;
  }

  list(): TrustGrant[] {
    return Array.from(this.grants.values()).sort((a, b) => a.pattern.localeCompare(b.pattern));
  }

  /**
   * Outcome-driven tuning: call on every human approval decision and every
   * approved execution result. Denials and post-approval failures reset the
   * streak; consecutive approved successes build it. Returns the streak.
   */
  recordApprovalResolved(toolId: string, approved: boolean): number {
    if (!approved) {
      this.streaks.delete(toolId);
      this.save();
      return 0;
    }
    return this.streaks.get(toolId)?.approvedStreak ?? 0;
  }

  recordApprovedExecution(toolId: string, succeeded: boolean): { streak: number; autoGranted: boolean } {
    if (!succeeded) {
      this.streaks.delete(toolId);
      this.save();
      return { streak: 0, autoGranted: false };
    }
    const streak = (this.streaks.get(toolId)?.approvedStreak ?? 0) + 1;
    this.streaks.set(toolId, { toolId, approvedStreak: streak, updatedAt: new Date().toISOString() });
    let autoGranted = false;
    if (streak >= TRUST_SUGGEST_THRESHOLD && !this.isTrusted(toolId) && process.env.MARK_AUTO_TRUST === 'true') {
      this.trust(toolId, 'auto-tuned');
      autoGranted = true;
    } else {
      this.save();
    }
    return { streak, autoGranted };
  }

  /** Tools that earned standing trust by behavior but don't have it yet. */
  suggestTrust(threshold = TRUST_SUGGEST_THRESHOLD): TrustSuggestion[] {
    return Array.from(this.streaks.values())
      .filter(streak => streak.approvedStreak >= threshold && !this.isTrusted(streak.toolId))
      .sort((a, b) => b.approvedStreak - a.approvedStreak)
      .map(streak => ({
        toolId: streak.toolId,
        approvedStreak: streak.approvedStreak,
        reason: `${streak.approvedStreak} consecutive approved successes; no denial or failure since. Grant with: mark trust ${streak.toolId}`,
      }));
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as { grants?: TrustGrant[]; streaks?: TrustStreak[] };
      for (const grant of parsed.grants ?? []) {
        if (grant?.pattern) {
          if (grant.scopePath) grant.scopePath = path.resolve(grant.scopePath);
          this.grants.set(`${grant.pattern}::${grant.scopePath ?? ''}`, grant);
        }
      }
      for (const streak of parsed.streaks ?? []) {
        if (streak?.toolId) this.streaks.set(streak.toolId, streak);
      }
    } catch {
      // Missing or corrupt file: start empty, never crash startup.
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ grants: this.list(), streaks: Array.from(this.streaks.values()) }, null, 2));
    } catch {
      // Best effort: a trusted tool simply asks again next session.
    }
  }
}

export const trustStore = new TrustStore();
