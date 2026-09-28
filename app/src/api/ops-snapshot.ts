/**
 * Ops world-model snapshot: what MARK knows about its environment.
 *
 * Single canonical builder for GET /api/status/ops (there were two
 * competing route handlers; the second `res.json` crashed per request
 * with headers-already-sent). Shape follows the phase-3 contract
 * (openIncidents, repoHealth, anomalies, autoFix, selfKnowledge) plus
 * the degraded-mode fields (objective, monitoredRepos, selfImprovement,
 * degraded[]). Never throws and never 500s: every section degrades to
 * null independently when its store is unavailable.
 */
import { incidentStore } from '../core/incident';
import { opsMemory } from '../core/ops-memory';
import { repoBaseline } from '../core/repo-baseline';
import { repositoryRegistry } from '../repositories/registry';
import { opsObjective } from '../ops/objective';
import { markRuntime } from '../core/mark-runtime';

export interface OpsSnapshot {
  timestamp: string;
  degraded: string[];
  objective: unknown;
  openIncidents: { total: number; bySeverity: Record<string, number> } | null;
  monitoredRepos: Array<{
    fullName: string;
    localPath: string | null;
    openIncidents: number;
    totalIncidents: number | null;
    avgIncidentsPerDay: number | null;
    avgResolutionMs: number | null;
    mostCommonType: string | null;
    baselineUpdatedAt: string | null;
  }> | null;
  repoHealth: Array<{
    repository: string;
    avgIncidentsPerDay: number;
    avgResolutionMs: number;
    mostCommonType: string | null;
    totalIncidents: number;
    lastUpdated: string;
    anomaly: unknown;
  }>;
  anomalies: unknown[];
  autoFix: { attempts: number; successes: number; rate: number; mostCommonFailureTypeThisWeek: string | null } | null;
  selfImprovement: Array<{ id: string; title: string; status: string; severity: string }> | null;
  mostCommonFailureThisWeek: string | null;
  selfKnowledge: {
    totalMemoryRecords: number;
    trustedFixTypes: string[];
    kernelInitialized: boolean;
    kernelToolCount: number;
  };
}

async function distinctFailureTypes(): Promise<string[]> {
  try {
    const { getPool } = await import('../db/postgres.js');
    const r = await getPool().query<{ failure_type: string }>(
      'SELECT DISTINCT failure_type FROM ops_incident_memory LIMIT 50',
    );
    return r.rows.map(row => row.failure_type).filter(Boolean);
  } catch {
    return [];
  }
}

export async function buildOpsSnapshot(): Promise<OpsSnapshot> {
  const snapshot: OpsSnapshot = {
    timestamp: new Date().toISOString(),
    degraded: [],
    objective: opsObjective.snapshot(),
    openIncidents: null,
    monitoredRepos: null,
    repoHealth: [],
    anomalies: [],
    autoFix: null,
    selfImprovement: null,
    mostCommonFailureThisWeek: null,
    selfKnowledge: { totalMemoryRecords: 0, trustedFixTypes: [], kernelInitialized: false, kernelToolCount: 0 },
  };

  try {
    const open = await incidentStore.getOpenIncidents();
    const bySeverity: Record<string, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    const byRepo: Record<string, number> = {};
    for (const inc of open) {
      bySeverity[inc.severity] = (bySeverity[inc.severity] ?? 0) + 1;
      const repo = (inc.context as Record<string, unknown> | undefined)?.repository;
      const key = typeof repo === 'string' ? repo : 'unknown';
      byRepo[key] = (byRepo[key] ?? 0) + 1;
    }
    snapshot.openIncidents = { total: open.length, bySeverity };
    snapshot.selfImprovement = open
      .filter(i => (i.tags ?? []).includes('self-improvement'))
      .map(i => ({ id: i.id, title: i.title, status: i.status, severity: i.severity }));

    const baselines = await repoBaseline.list().catch(() => null);
    if (!baselines) {
      snapshot.degraded.push('baselines');
    } else {
      let anomalyMap = new Map<string, unknown>();
      try {
        const found = await repoBaseline.detectAnomalies();
        anomalyMap = new Map(found.map(a => [a.repository, a]));
        snapshot.anomalies = found;
      } catch {
        snapshot.degraded.push('anomalies');
      }
      snapshot.repoHealth = baselines.map(b => ({
        repository: b.repository,
        avgIncidentsPerDay: b.avgIncidentsPerDay,
        avgResolutionMs: b.avgResolutionMs,
        mostCommonType: b.mostCommonType,
        totalIncidents: b.totalIncidents,
        lastUpdated: b.updatedAt,
        anomaly: anomalyMap.get(b.repository) ?? null,
      }));
    }

    const repos = await repositoryRegistry.loadFromDatabase().catch(() => repositoryRegistry.list());
    const baseByRepo = new Map((await repoBaseline.list().catch(() => []))?.map(b => [b.repository, b]) ?? []);
    snapshot.monitoredRepos = repos.map(r => {
      const base = baseByRepo.get(r.fullName);
      return {
        fullName: r.fullName,
        localPath: r.localPath ?? null,
        openIncidents: byRepo[r.fullName] ?? 0,
        totalIncidents: base?.totalIncidents ?? null,
        avgIncidentsPerDay: base?.avgIncidentsPerDay ?? null,
        avgResolutionMs: base?.avgResolutionMs ?? null,
        mostCommonType: base?.mostCommonType ?? null,
        baselineUpdatedAt: base?.updatedAt ?? null,
      };
    });
  } catch {
    snapshot.degraded.push('incidents');
  }

  try {
    const fixRate = await opsMemory.overallFixRate(30);
    snapshot.autoFix = {
      attempts: fixRate.attempts,
      successes: fixRate.successes,
      rate: Math.round(fixRate.rate * 1000) / 10,
      mostCommonFailureTypeThisWeek: await opsMemory.mostCommonFailureType(7),
    };
  } catch {
    snapshot.degraded.push('autofix');
  }

  try {
    snapshot.mostCommonFailureThisWeek = await opsMemory.mostCommonFailureType(7);
  } catch {
    snapshot.degraded.push('failures');
  }

  try {
    const { getPool } = await import('../db/postgres.js');
    const r = await getPool().query<{ n: string }>('SELECT COUNT(*)::int AS n FROM ops_incident_memory');
    snapshot.selfKnowledge.totalMemoryRecords = Number(r.rows[0]?.n ?? 0);
  } catch {
    snapshot.degraded.push('memory');
  }
  for (const type of await distinctFailureTypes()) {
    try {
      if (await opsMemory.isTrusted(type)) snapshot.selfKnowledge.trustedFixTypes.push(type);
    } catch { /* one type failing must not sink the list */ }
  }

  try {
    const kernelStatus = markRuntime.kernelStatus();
    snapshot.selfKnowledge.kernelInitialized = kernelStatus.initialized;
    snapshot.selfKnowledge.kernelToolCount = kernelStatus.availableTools.length;
  } catch {
    snapshot.degraded.push('kernel');
  }

  return snapshot;
}
