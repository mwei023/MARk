/**
 * MARK World Model: one fused scene every perception domain writes to.
 *
 * God's Eye pattern, MARK-ified: independent layer pollers (repo scans,
 * quake feeds, container health, and later network/voice/finance) each
 * normalize their findings into domain snapshots HERE. Reasoning and the
 * kernel query the scene — never the raw sources. "Mark already knows
 * everything happening" starts with this registry knowing it first.
 *
 * In-memory now (fast, test-safe); Postgres persistence is the next step
 * once the snapshot shape settles.
 */
export type WorldDomain =
  | 'computer'
  | 'network'
  | 'repository'
  | 'system'
  | 'world'
  | 'financial'
  | 'human';

export interface DomainSnapshot {
  domain: WorldDomain;
  updatedAt: string;
  source: string;
  /** One-line human summary, e.g. "3 quakes ≥ M4.5 in the last day". */
  summary: string;
  /** Counts by kind, e.g. { quakes: 12, strongest: 5.1 }. */
  counts: Record<string, number>;
  /** Top items, newest or strongest first, already truncated. */
  items: Array<Record<string, unknown>>;
}

const snapshots = new Map<WorldDomain, DomainSnapshot>();

export function recordSnapshot(snapshot: DomainSnapshot): DomainSnapshot {
  snapshots.set(snapshot.domain, { ...snapshot, updatedAt: new Date().toISOString() });
  return snapshots.get(snapshot.domain)!;
}

export function getSnapshot(domain: WorldDomain): DomainSnapshot | undefined {
  return snapshots.get(domain);
}

export function listSnapshots(): DomainSnapshot[] {
  return [...snapshots.values()];
}

/** One-paragraph rendering of everything MARK currently knows. */
export function renderWorldModel(): string {
  const all = listSnapshots();
  if (all.length === 0) return 'World model is empty: no perception domain has reported yet.';
  return all
    .map(s => `[${s.domain}] ${s.summary} (via ${s.source}, ${s.updatedAt})`)
    .join('\n');
}

export function clearWorldModel(): void {
  snapshots.clear();
}
