/**
 * World-perception tools: MARK's first God's Eye layer.
 *
 * Each tool is an independent poller over a free, no-auth public feed that
 * normalizes findings into the world model (src/world/model.ts). Reasoning
 * and the kernel then query the scene via world.snapshot — never the feed.
 *
 * First layer is geospatial (USGS earthquakes, GeoJSON, public domain):
 * it proves the ingest→normalize→fuse pattern with zero keys. Network,
 * financial, and human layers plug into the same recordSnapshot call.
 */
import type { DiscoveryProvider } from '../tool-discovery';
import type { ToolDescriptor, ToolImplementation } from '../index';
import { recordSnapshot, getSnapshot, listSnapshots, renderWorldModel } from '../../world/model';

const FETCH_TIMEOUT_MS = 20000;
const USGS_DAY_FEED = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';

function okOutput(extra: Record<string, unknown>): Record<string, unknown> {
  return { ok: true, capturedAt: new Date().toISOString(), ...extra };
}

function failOutput(reason: string): Record<string, unknown> {
  return { ok: false, reason: reason.slice(0, 300), capturedAt: new Date().toISOString() };
}

const worldQuakesTool: ToolDescriptor = {
  id: 'world.quakes',
  name: 'Earthquake perception',
  description: 'Polls the free USGS day feed and fuses the strongest quakes into the world model. First geospatial sense: what moved on Earth today.',
  version: '1.0.0',
  domain: 'world',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      minMagnitude: { type: 'number', description: 'Minimum magnitude to keep (default 4.5, range 0-10).' },
      limit: { type: 'number', description: 'Max quakes to fuse (default 10, max 20).' },
    },
    required: [],
  },
  capabilities: ['geospatial', 'public-feeds'],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'world.perception',
};

const worldQuakesImplementation: ToolImplementation = {
  toolId: worldQuakesTool.id,
  async execute({ action }) {
    const minMag = typeof action.input.minMagnitude === 'number'
      ? Math.min(Math.max(action.input.minMagnitude, 0), 10)
      : 4.5;
    const limit = typeof action.input.limit === 'number'
      ? Math.min(Math.max(Math.floor(action.input.limit), 1), 20)
      : 10;
    try {
      const response = await fetch(USGS_DAY_FEED, {
        headers: { 'User-Agent': 'MARK/1.0 (world perception)', Accept: 'application/geo+json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) return { output: failOutput(`USGS feed failed: ${response.status}`) };
      const feed = await response.json() as { features?: Array<{ properties?: { mag?: number; place?: string; time?: number; url?: string } }> };
      const features = Array.isArray(feed.features) ? feed.features : [];
      const kept = features
        .map(f => ({
          mag: typeof f.properties?.mag === 'number' ? f.properties.mag : 0,
          place: String(f.properties?.place ?? 'unknown').slice(0, 160),
          time: typeof f.properties?.time === 'number' ? new Date(f.properties.time).toISOString() : null,
          url: String(f.properties?.url ?? '').slice(0, 300),
        }))
        .filter(q => q.mag >= minMag)
        .sort((a, b) => b.mag - a.mag)
        .slice(0, limit);
      const strongest = kept.length > 0 ? kept[0].mag : 0;
      const snapshot = recordSnapshot({
        domain: 'world',
        updatedAt: new Date().toISOString(),
        source: 'usgs-day-feed',
        summary: kept.length > 0
          ? `${kept.length} quake(s) ≥ M${minMag} in the last day, strongest M${strongest} (${kept[0].place})`
          : `No quakes ≥ M${minMag} in the last day — Earth is quiet`,
        counts: { quakes: kept.length, strongest },
        items: kept,
      });
      return { output: okOutput({ fused: kept.length, summary: snapshot.summary, quakes: kept }) };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

const worldSnapshotTool: ToolDescriptor = {
  id: 'world.snapshot',
  name: 'World model snapshot',
  description: 'Reads the fused world model: one summary per perception domain that has reported. What MARK currently knows is happening.',
  version: '1.0.0',
  domain: 'world',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      domain: { type: 'string', description: 'Optional single domain: computer, network, repository, system, world, financial, human.' },
    },
    required: [],
  },
  capabilities: ['world-model'],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'world.perception',
};

const worldSnapshotImplementation: ToolImplementation = {
  toolId: worldSnapshotTool.id,
  async execute({ action }) {
    const domain = typeof action.input.domain === 'string' ? action.input.domain.trim().toLowerCase() : '';
    if (domain) {
      const snap = getSnapshot(domain as Parameters<typeof getSnapshot>[0]);
      if (!snap) return { output: okOutput({ domain, reported: false, summary: `No ${domain} perception has reported yet.` }) };
      return { output: okOutput({ domain, reported: true, summary: snap.summary, counts: snap.counts, items: snap.items.slice(0, 10) }) };
    }
    return { output: okOutput({ reported: listSnapshots().length, scene: renderWorldModel() }) };
  },
};

export const worldPerceptionTools: ToolDescriptor[] = [worldQuakesTool, worldSnapshotTool];

export const worldPerceptionImplementations: ToolImplementation[] = [worldQuakesImplementation, worldSnapshotImplementation];

export const worldPerceptionDiscoveryProvider: DiscoveryProvider = {
  id: 'world.perception',
  name: 'World perception',
  description: 'God\'s Eye layers for MARK: public-feed pollers fused into one world model.',
  async isAvailable(): Promise<boolean> {
    return true;
  },
  async discoverResources(): Promise<[]> {
    return [];
  },
  async discoverTools(): Promise<ToolDescriptor[]> {
    return worldPerceptionTools;
  },
};
