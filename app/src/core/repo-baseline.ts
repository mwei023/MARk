/**
 * Repo Baseline — tracks failure frequency and resolution time per repository.
 *
 * After enough data accumulates, compares current week's behaviour against
 * the rolling baseline to detect anomalies (repos failing more than usual).
 *
 * Storage: repo_baselines table (migration 006).
 * All computations are in-process from Postgres aggregates — no ML.
 */

import { getPool } from '../db/postgres';

export interface RepoBaseline {
  repository: string;
  /** Average incidents per day over the last 30 days. */
  avgIncidentsPerDay: number;
  /** Average resolution time in milliseconds over last 30 days. */
  avgResolutionMs: number;
  /** Total incidents recorded (all time). */
  totalIncidents: number;
  /** Most common failure type. */
  mostCommonType: string | null;
  /** When baseline was last refreshed. */
  updatedAt: string;
}

export interface AnomalyReport {
  repository: string;
  /** How many times above baseline the current rate is. */
  rateMultiplier: number;
  /** Incidents this week. */
  currentWeekCount: number;
  /** Expected per week based on baseline. */
  expectedWeekCount: number;
  /** Human-readable summary. */
  summary: string;
}

/** Multiplier threshold above which a repo is considered anomalous. */
const ANOMALY_THRESHOLD = 2.0;
/** Minimum baseline incidents before anomaly detection is meaningful. */
const MIN_BASELINE_INCIDENTS = 3;

export class RepoBaselineTracker {
  /**
   * Refresh the baseline for a repository by querying incident history.
   * Called after each incident resolution (fire-and-forget safe).
   */
  async refresh(repository: string): Promise<RepoBaseline | undefined> {
    try {
      const pool = getPool();
      const since30d = new Date(Date.now() - 30 * 86400 * 1000).toISOString();

      // Count incidents and avg resolution time over 30 days
      const statsResult = await pool.query<{
        count: string;
        avg_resolution_ms: string | null;
      }>(
        `SELECT
           COUNT(*)::int AS count,
           AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) * 1000)::bigint AS avg_resolution_ms
         FROM incidents
         WHERE context->>'repository' = $1
           AND created_at > $2`,
        [repository, since30d],
      );

      const stats = statsResult.rows[0];
      const totalIncidents = Number(stats?.count ?? 0);
      const avgResolutionMs = Number(stats?.avg_resolution_ms ?? 0);
      const avgIncidentsPerDay = totalIncidents / 30;

      // Most common failure type from ops memory
      const typeResult = await pool.query<{ failure_type: string }>(
        `SELECT failure_type, COUNT(*)::int AS n
         FROM ops_incident_memory
         WHERE repository = $1 AND created_at > $2 AND failure_type != 'UNKNOWN'
         GROUP BY failure_type ORDER BY n DESC LIMIT 1`,
        [repository, since30d],
      );
      const mostCommonType = typeResult.rows[0]?.failure_type ?? null;

      const baseline: RepoBaseline = {
        repository,
        avgIncidentsPerDay,
        avgResolutionMs,
        totalIncidents,
        mostCommonType,
        updatedAt: new Date().toISOString(),
      };

      // Upsert into repo_baselines table
      await pool.query(
        `INSERT INTO repo_baselines (repository, avg_incidents_per_day, avg_resolution_ms, total_incidents, most_common_type, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (repository) DO UPDATE SET
           avg_incidents_per_day = EXCLUDED.avg_incidents_per_day,
           avg_resolution_ms = EXCLUDED.avg_resolution_ms,
           total_incidents = EXCLUDED.total_incidents,
           most_common_type = EXCLUDED.most_common_type,
           updated_at = NOW()`,
        [repository, avgIncidentsPerDay, avgResolutionMs, totalIncidents, mostCommonType],
      );

      return baseline;
    } catch (err) {
      console.debug('[repo-baseline] refresh failed:', err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  /**
   * Get the stored baseline for a repository.
   */
  async get(repository: string): Promise<RepoBaseline | null> {
    try {
      const pool = getPool();
      const result = await pool.query<any>(
        `SELECT * FROM repo_baselines WHERE repository = $1`,
        [repository],
      );
      if (result.rows.length === 0) return null;
      return this.rowToBaseline(result.rows[0]);
    } catch {
      return null;
    }
  }

  /**
   * List baselines for all monitored repositories.
   */
  async list(): Promise<RepoBaseline[]> {
    try {
      const pool = getPool();
      const result = await pool.query<any>(
        `SELECT * FROM repo_baselines ORDER BY avg_incidents_per_day DESC`,
      );
      return result.rows.map((r: any) => this.rowToBaseline(r));
    } catch {
      return [];
    }
  }

  /**
   * Detect anomalies: repos failing significantly more than their baseline.
   * Returns one report per anomalous repo, sorted by rate multiplier descending.
   */
  async detectAnomalies(): Promise<AnomalyReport[]> {
    try {
      const pool = getPool();
      const since7d = new Date(Date.now() - 7 * 86400 * 1000).toISOString();

      // Current week's incident counts per repo
      const weekResult = await pool.query<{ repository: string; count: string }>(
        `SELECT context->>'repository' AS repository, COUNT(*)::int AS count
         FROM incidents
         WHERE created_at > $1
           AND context->>'repository' IS NOT NULL
           AND context->>'repository' != ''
         GROUP BY context->>'repository'`,
        [since7d],
      );

      const baselines = await this.list();
      const baselineMap = new Map(baselines.map(b => [b.repository, b]));

      const reports: AnomalyReport[] = [];
      for (const row of weekResult.rows) {
        const repo = row.repository;
        const currentWeekCount = Number(row.count);
        const baseline = baselineMap.get(repo);

        if (!baseline || baseline.totalIncidents < MIN_BASELINE_INCIDENTS) continue;

        const expectedWeekCount = baseline.avgIncidentsPerDay * 7;
        if (expectedWeekCount < 0.5) continue; // too sparse to be meaningful

        const rateMultiplier = currentWeekCount / expectedWeekCount;
        if (rateMultiplier < ANOMALY_THRESHOLD) continue;

        reports.push({
          repository: repo,
          rateMultiplier: Math.round(rateMultiplier * 10) / 10,
          currentWeekCount,
          expectedWeekCount: Math.round(expectedWeekCount * 10) / 10,
          summary: `${repo} is failing ${rateMultiplier.toFixed(1)}x more than usual this week (${currentWeekCount} incidents vs ${expectedWeekCount.toFixed(1)} expected).`,
        });
      }

      return reports.sort((a, b) => b.rateMultiplier - a.rateMultiplier);
    } catch (err) {
      console.debug('[repo-baseline] detectAnomalies failed:', err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  /**
   * Get anomaly report for a specific repo, if any.
   * Used to add a finding when a new incident is created.
   */
  async checkAnomaly(repository: string): Promise<AnomalyReport | null> {
    try {
      const pool = getPool();
      const since7d = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
      const baseline = await this.get(repository);

      if (!baseline || baseline.totalIncidents < MIN_BASELINE_INCIDENTS) return null;

      const weekResult = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::int AS count FROM incidents
         WHERE context->>'repository' = $1 AND created_at > $2`,
        [repository, since7d],
      );

      const currentWeekCount = Number(weekResult.rows[0]?.count ?? 0);
      const expectedWeekCount = baseline.avgIncidentsPerDay * 7;
      if (expectedWeekCount < 0.5) return null;

      const rateMultiplier = currentWeekCount / expectedWeekCount;
      if (rateMultiplier < ANOMALY_THRESHOLD) return null;

      return {
        repository,
        rateMultiplier: Math.round(rateMultiplier * 10) / 10,
        currentWeekCount,
        expectedWeekCount: Math.round(expectedWeekCount * 10) / 10,
        summary: `${repository} is failing ${rateMultiplier.toFixed(1)}x more than usual this week.`,
      };
    } catch {
      return null;
    }
  }

  private rowToBaseline(row: any): RepoBaseline {
    return {
      repository: row.repository,
      avgIncidentsPerDay: Number(row.avg_incidents_per_day),
      avgResolutionMs: Number(row.avg_resolution_ms),
      totalIncidents: Number(row.total_incidents),
      mostCommonType: row.most_common_type ?? null,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    };
  }
}

export const repoBaseline = new RepoBaselineTracker();
