/**
 * Seed strategy priors from historical incident outcomes.
 *
 * Past incidents were handled single-agent, so verified records become
 * `solo` trials for their mapped task class. Costs are unknown for
 * history (tokens recorded as 0) — this makes seeded solo priors
 * OPTIMISTIC, which is the conservative direction: teams must beat a
 * flattered baseline for real. Unmapped failure types are skipped and
 * counted, never shoehorned. Idempotent: pairs already holding seeded
 * rows are left alone.
 *
 * Usage: set -a; source ../.env; set +a; npx tsx Scripts/seed-strategy-priors.ts
 */
import { getPool } from '../src/db/postgres';
import { recordTrial, failureTypeToTaskClass, DEFAULT_WEIGHTS } from '../src/kernel/strategy';

(async () => {
  const pool = getPool();
  const rows = (await pool.query(
    `SELECT incident_id, trigger_event, failure_type, repository, resolution,
            success, duration_ms, verified, verified_count
     FROM ops_incident_memory ORDER BY created_at ASC`,
  )).rows as Array<{
    incident_id: string; trigger_event: string; failure_type: string; repository: string | null;
    resolution: string; success: boolean; duration_ms: string; verified: boolean; verified_count: number;
  }>;
  let seeded = 0;
  let skipped = 0;
  const seen = new Set<string>();
  for (const row of rows) {
    const taskClass = failureTypeToTaskClass(row.failure_type);
    if (!taskClass) {
      skipped++;
      continue;
    }
    const pair = `${taskClass}:solo`;
    if (!seen.has(pair)) {
      seen.add(pair);
      const existing = await pool.query(
        `SELECT 1 FROM strategy_trials WHERE task_class = $1 AND strategy_id = 'solo' AND weights_version = 'u-v1-seed' LIMIT 1`,
        [taskClass],
      );
      if ((existing.rows.length ?? 0) > 0) {
        console.log(`skip ${pair}: seeded rows already present`);
        continue;
      }
    }
    await recordTrial({
      taskClass,
      classifierVersion: 'tc-v1-seed',
      strategyId: 'solo',
      strategyVersion: 'v1',
      trial: {
        success: row.success,
        verified: row.verified,
        regression: false,
        tokens: 0,
        durationMs: Number(row.duration_ms ?? 0),
      },
      weights: { ...DEFAULT_WEIGHTS, version: 'u-v1-seed' },
    });
    seeded++;
  }
  console.log(`seeded=${seeded} skipped=${skipped} (of ${rows.length} incident records)`);
  process.exit(0);
})().catch(err => {
  console.error('seed failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
