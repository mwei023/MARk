/**
 * Ops Memory — incident outcome summaries for the ops domain.
 *
 * After an incident resolves, a compact summary is saved so future incidents
 * of the same type can benefit from prior experience. On new incident creation,
 * the memory is queried and the best match is surfaced as a finding.
 *
 * Storage: ops_incident_memory table (migration 006).
 * Matching: structural (triggerEvent + failureType + repository) — no embeddings,
 * no LLM. This keeps memory fast, offline-safe, and deterministic.
 *
 * Fix effectiveness: each memory record tracks whether the fix was verified
 * (i.e. a subsequent successful run was observed after the auto-fix).
 * After N_TRUSTED_THRESHOLD verified successes, a fix type is promoted to
 * 'trusted' status — used by GitAgent to decide auto-fix confidence.
 */

import { getPool } from '../db/postgres';

export interface OpsMemoryRecord {
  id: string;
  /** Incident that produced this memory. */
  incidentId: string;
  /** github.workflow.failed | github.deployment.failed | docker.container.* */
  triggerEvent: string;
  /** MISSING_DEPENDENCY | TYPE_ERROR | LINT_FAILURE | UNKNOWN etc. */
  failureType: string;
  /** Confidence of the original classification (0–1). */
  classificationConfidence: number;
  /** Which repo this came from (owner/name). */
  repository: string | null;
  /** What was done to resolve it. */
  resolution: string;
  /** Whether the resolution succeeded. */
  success: boolean;
  /** How long it took in milliseconds. */
  durationMs: number;
  /** Whether a follow-up run confirmed the fix worked. */
  verified: boolean;
  /** How many times this pattern has been verified as successful. */
  verifiedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SaveOpsMemoryInput {
  incidentId: string;
  triggerEvent: string;
  failureType: string;
  classificationConfidence: number;
  repository: string | null;
  resolution: string;
  success: boolean;
  durationMs: number;
}

export interface RecallResult {
  record: OpsMemoryRecord;
  /** Why this record was matched. */
  matchReason: string;
}

/** After this many verified successes, a fix type is promoted to trusted. */
export const N_TRUSTED_THRESHOLD = 5;

export class OpsMemory {
  /**
   * Save an outcome summary after an incident resolves.
   * Upserts on (incidentId) — safe to call multiple times.
   */
  async save(input: SaveOpsMemoryInput): Promise<OpsMemoryRecord | undefined> {
    try {
      const pool = getPool();
      const id = `OM-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const now = new Date().toISOString();

      await pool.query(
        `INSERT INTO ops_incident_memory (
           id, incident_id, trigger_event, failure_type, classification_confidence,
           repository, resolution, success, duration_ms, verified, verified_count,
           created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,0,$10,$10)
         ON CONFLICT (incident_id) DO UPDATE SET
           resolution = EXCLUDED.resolution,
           success = EXCLUDED.success,
           duration_ms = EXCLUDED.duration_ms,
           updated_at = EXCLUDED.updated_at`,
        [
          id, input.incidentId, input.triggerEvent, input.failureType,
          input.classificationConfidence, input.repository,
          input.resolution, input.success, input.durationMs, now,
        ],
      );

      return {
        id, ...input, verified: false, verifiedCount: 0,
        createdAt: now, updatedAt: now,
      };
    } catch (err) {
      console.debug('[ops-memory] save failed:', err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  /**
   * Mark a memory record as verified — the fix worked on follow-up.
   * Called when github.workflow.completed fires after an auto-fix.
   */
  async markVerified(incidentId: string): Promise<void> {
    try {
      const pool = getPool();
      await pool.query(
        `UPDATE ops_incident_memory
         SET verified = true,
             verified_count = verified_count + 1,
             updated_at = NOW()
         WHERE incident_id = $1`,
        [incidentId],
      );
    } catch (err) {
      console.debug('[ops-memory] markVerified failed:', err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Recall the best matching prior resolution for an incoming incident.
   * Match priority:
   *   1. Same failureType + same repository (best)
   *   2. Same failureType + any repository (good)
   *   3. Same triggerEvent + same repository (fallback)
   * Only returns successful resolutions.
   */
  async recall(
    triggerEvent: string,
    failureType: string,
    repository: string | null,
  ): Promise<RecallResult | undefined> {
    try {
      const pool = getPool();

      // Try match 1: same failureType + same repository
      if (repository && failureType !== 'UNKNOWN') {
        const r1 = await pool.query<OpsMemoryRecord & { incident_id: string; trigger_event: string; failure_type: string; classification_confidence: string; duration_ms: string; verified_count: string; created_at: Date; updated_at: Date }>(
          `SELECT * FROM ops_incident_memory
           WHERE failure_type = $1 AND repository = $2 AND success = true
           ORDER BY verified_count DESC, created_at DESC LIMIT 1`,
          [failureType, repository],
        );
        if (r1.rows.length > 0) {
          return { record: this.rowToRecord(r1.rows[0]), matchReason: `same failure type (${failureType}) in same repository` };
        }
      }

      // Try match 2: same failureType, any repo
      if (failureType !== 'UNKNOWN') {
        const r2 = await pool.query<any>(
          `SELECT * FROM ops_incident_memory
           WHERE failure_type = $1 AND success = true
           ORDER BY verified_count DESC, created_at DESC LIMIT 1`,
          [failureType],
        );
        if (r2.rows.length > 0) {
          return { record: this.rowToRecord(r2.rows[0]), matchReason: `same failure type (${failureType}) in a different repository` };
        }
      }

      // Try match 3: same triggerEvent + same repository
      if (repository) {
        const r3 = await pool.query<any>(
          `SELECT * FROM ops_incident_memory
           WHERE trigger_event = $1 AND repository = $2 AND success = true
           ORDER BY verified_count DESC, created_at DESC LIMIT 1`,
          [triggerEvent, repository],
        );
        if (r3.rows.length > 0) {
          return { record: this.rowToRecord(r3.rows[0]), matchReason: `same trigger event in same repository` };
        }
      }

      return undefined;
    } catch (err) {
      console.debug('[ops-memory] recall failed:', err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  /**
   * Auto-fix success rate for a given failure type over the last N days.
   * Returns { attempts, successes, verifiedSuccesses, rate }.
   */
  async fixEffectiveness(
    failureType: string,
    days = 30,
  ): Promise<{ attempts: number; successes: number; verifiedSuccesses: number; rate: number }> {
    try {
      const pool = getPool();
      const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
      const result = await pool.query<{ attempts: string; successes: string; verified_successes: string }>(
        `SELECT
           COUNT(*)::int AS attempts,
           SUM(CASE WHEN success THEN 1 ELSE 0 END)::int AS successes,
           SUM(CASE WHEN verified THEN 1 ELSE 0 END)::int AS verified_successes
         FROM ops_incident_memory
         WHERE failure_type = $1 AND created_at > $2`,
        [failureType, since],
      );
      const row = result.rows[0];
      const attempts = Number(row?.attempts ?? 0);
      const successes = Number(row?.successes ?? 0);
      const verifiedSuccesses = Number(row?.verified_successes ?? 0);
      return {
        attempts,
        successes,
        verifiedSuccesses,
        rate: attempts === 0 ? 0 : successes / attempts,
      };
    } catch {
      return { attempts: 0, successes: 0, verifiedSuccesses: 0, rate: 0 };
    }
  }

  /**
   * Overall auto-fix success rate across all types, last N days.
   */
  async overallFixRate(days = 30): Promise<{ attempts: number; successes: number; rate: number }> {
    try {
      const pool = getPool();
      const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
      const result = await pool.query<{ attempts: string; successes: string }>(
        `SELECT COUNT(*)::int AS attempts,
                SUM(CASE WHEN success THEN 1 ELSE 0 END)::int AS successes
         FROM ops_incident_memory WHERE created_at > $1`,
        [since],
      );
      const row = result.rows[0];
      const attempts = Number(row?.attempts ?? 0);
      const successes = Number(row?.successes ?? 0);
      return { attempts, successes, rate: attempts === 0 ? 0 : successes / attempts };
    } catch {
      return { attempts: 0, successes: 0, rate: 0 };
    }
  }

  /**
   * Most common failure type in the last N days.
   */
  async mostCommonFailureType(days = 7): Promise<string | null> {
    try {
      const pool = getPool();
      const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
      const result = await pool.query<{ failure_type: string }>(
        `SELECT failure_type, COUNT(*)::int AS n
         FROM ops_incident_memory
         WHERE created_at > $1 AND failure_type != 'UNKNOWN'
         GROUP BY failure_type ORDER BY n DESC LIMIT 1`,
        [since],
      );
      return result.rows[0]?.failure_type ?? null;
    } catch {
      return null;
    }
  }

  /** Whether a fix type has reached the trusted threshold. */
  async isTrusted(failureType: string): Promise<boolean> {
    try {
      const pool = getPool();
      const result = await pool.query<{ total: string }>(
        `SELECT SUM(verified_count)::int AS total
         FROM ops_incident_memory
         WHERE failure_type = $1 AND success = true`,
        [failureType],
      );
      return Number(result.rows[0]?.total ?? 0) >= N_TRUSTED_THRESHOLD;
    } catch {
      return false;
    }
  }

  private rowToRecord(row: any): OpsMemoryRecord {
    return {
      id: row.id,
      incidentId: row.incident_id,
      triggerEvent: row.trigger_event,
      failureType: row.failure_type,
      classificationConfidence: Number(row.classification_confidence),
      repository: row.repository ?? null,
      resolution: row.resolution,
      success: row.success,
      durationMs: Number(row.duration_ms),
      verified: row.verified,
      verifiedCount: Number(row.verified_count),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    };
  }
}

export const opsMemory = new OpsMemory();
