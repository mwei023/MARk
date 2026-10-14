import { getPool } from '../db/postgres';

export interface ToolStats {
  toolId: string;
  success: number;
  failure: number;
  verifyFail: number;
  recoverySuccess: number;
  updatedAt: string;
}

export type ReliabilityOutcome = 'success' | 'failure' | 'verify_fail' | 'recovery_success';

/**
 * Per-tool reliability: Laplace-smoothed success rate over every recorded
 * outcome. Unknown tools score exactly 0.5 (neutral) so newcomers are
 * never punished for having no history — history only breaks ties.
 *
 * In-memory first (synchronous reads for the resolve path), Postgres
 * best-effort behind it. Silent no-op offline.
 */
export class ReliabilityTracker {
  private readonly stats = new Map<string, ToolStats>();
  private readonly pending = new Set<Promise<unknown>>();
  private loaded = false;

  /** Laplace-smoothed success rate in [0,1]; 0.5 when unknown. */
  score(toolId: string): number {
    const entry = this.stats.get(toolId);
    if (!entry) return 0.5;
    const total = entry.success + entry.failure;
    if (total === 0) return 0.5;
    return (entry.success + 1) / (total + 2);
  }

  get(toolId: string): ToolStats | undefined {
    return this.stats.get(toolId);
  }

  list(): ToolStats[] {
    return Array.from(this.stats.values()).sort((a, b) => this.score(b.toolId) - this.score(a.toolId));
  }

  record(toolId: string, outcome: ReliabilityOutcome): void {
    try {
      const entry = this.stats.get(toolId) ?? {
        toolId,
        success: 0,
        failure: 0,
        verifyFail: 0,
        recoverySuccess: 0,
        updatedAt: new Date().toISOString(),
      };
      if (outcome === 'success') entry.success += 1;
      else if (outcome === 'failure') entry.failure += 1;
      else if (outcome === 'verify_fail') {
        entry.failure += 1;
        entry.verifyFail += 1;
      } else if (outcome === 'recovery_success') {
        entry.success += 1;
        entry.recoverySuccess += 1;
      }
      entry.updatedAt = new Date().toISOString();
      this.stats.set(toolId, entry);
      void this.persist(entry);
    } catch {
      // Learning never breaks execution.
    }
  }

  async loadFromDatabase(limit = 500): Promise<number> {
    if (this.loaded) return this.stats.size;
    try {
      const result = await getPool().query(
        `SELECT tool_id, success, failure, verify_fail, recovery_success, updated_at
         FROM tool_reliability ORDER BY updated_at DESC LIMIT $1`,
        [limit],
      );
      for (const row of result.rows) {
        if (this.stats.has(row.tool_id)) continue;
        this.stats.set(row.tool_id, {
          toolId: row.tool_id,
          success: row.success ?? 0,
          failure: row.failure ?? 0,
          verifyFail: row.verify_fail ?? 0,
          recoverySuccess: row.recovery_success ?? 0,
          updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
        });
      }
      this.loaded = true;
      return this.stats.size;
    } catch {
      return this.stats.size;
    }
  }

  private async persist(entry: ToolStats): Promise<void> {
    const task = this.doPersist(entry);
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
    await task;
  }

  /** Await in-flight persists — CLI calls this before exit. */
  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled(Array.from(this.pending));
    }
  }

  private async doPersist(entry: ToolStats): Promise<void> {
    try {
      await getPool().query(
        `INSERT INTO tool_reliability (tool_id, success, failure, verify_fail, recovery_success, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (tool_id) DO UPDATE SET success = EXCLUDED.success, failure = EXCLUDED.failure,
           verify_fail = EXCLUDED.verify_fail, recovery_success = EXCLUDED.recovery_success, updated_at = NOW()`,
        [entry.toolId, entry.success, entry.failure, entry.verifyFail, entry.recoverySuccess],
      );
    } catch {
      // Best effort.
    }
  }
}

export const reliabilityTracker = new ReliabilityTracker();
