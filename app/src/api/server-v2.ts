/**
 * Mark API Server v2.0
 * Event-driven architecture with autonomous agents.
 *
 * Routes:
 * POST /webhooks/github  - GitHub events
 * POST /webhooks/docker  - Docker/container events
 * GET  /api/incidents    - List open incidents
 * GET  /api/incidents/:id - Get incident details
 * POST /api/approve      - User approves action (incident)
 * POST /api/command      - User command via MarkRuntime
 * POST /api/plan         - Like-Me plan preview (no mutating execution)
 * POST /api/execute      - Like-Me plan execution (confirmation-gated)
 * GET  /api/confirmations - List pending kernel confirmations
 * POST /api/confirmations - Approve/deny a kernel confirmation
 * GET  /api/health       - Health check
 */

import express from 'express';
import * as dotenv from 'dotenv';
import { incidentStore } from '../core/incident';
import { agentRuntime } from '../core/agent-runtime';
import { GitHubWebhookHandler } from '../webhooks/github';
import { DockerWebhookHandler } from '../webhooks/docker';
import { eventBus } from '../core/event-bus';
import { markRuntime } from '../core/mark-runtime';
import { likeMeLoop, LikeMeMode } from '../core/like-me-loop';
import { config } from '../config.js';
import { proposalStore } from '../core/proposal';
import { DevOpsAgent } from '../agents/devops-agent';
import { opsMemory } from '../core/ops-memory';
import { repoBaseline } from '../core/repo-baseline';
import { repositoryRegistry } from '../repositories/registry';
import { opsObjective } from '../ops/objective';

// Load env: repo-root .env first (LLM keys), then app/.env fills gaps.
import * as path from 'path';
for (const candidate of [
  path.join(__dirname, '../../../.env'),
  path.join(process.cwd(), '../.env'),
  path.join(process.cwd(), '.env'),
]) {
  dotenv.config({ path: candidate });
}

const app = express();
app.use(express.json({
  verify: (req: any, _res: any, buf: any) => {
    req.rawBody = buf;
  },
}));

// ─────────────────────────────────────────────────────────────
// Optional API auth: set API_TOKEN to require Bearer/x-api-token on /api/*.
// Webhooks keep their own HMAC secrets and are excluded here.
// ─────────────────────────────────────────────────────────────
const API_TOKEN = process.env.API_TOKEN;
if (!API_TOKEN) {
  console.warn('[api] API_TOKEN not set — /api/* is open (local-first default). Set API_TOKEN to lock it down.');
}
app.use('/api', (req: any, res: any, next: any) => {
  if (!API_TOKEN) return next();
  const header = String(req.headers?.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : String(req.headers?.['x-api-token'] || '');
  if (token && token === API_TOKEN) return next();
  return res.status(401).json({ success: false, error: 'Unauthorized' });
});

// ─────────────────────────────────────────────────────────────
// Webhook Receivers
// ─────────────────────────────────────────────────────────────
const githubHandler = new GitHubWebhookHandler(eventBus);
app.post('/webhooks/github', githubHandler.handler());
const dockerHandler = new DockerWebhookHandler(eventBus);
app.post('/webhooks/docker', dockerHandler.handler());

// ─────────────────────────────────────────────────────────────
// API Endpoints
// ─────────────────────────────────────────────────────────────

/**
 * GET /api/incidents - List all open incidents
 */
app.get('/api/incidents', async (req: any, res: any) => {
  try {
    const incidents = await incidentStore.getOpenIncidents();
    res.json({
      success: true,
      count: incidents.length,
      incidents,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/incidents/:id — Full incident detail including investigation findings.
 *
 * Response shape:
 * {
 *   success: true,
 *   incident: { ...all fields... },
 *   summary: {
 *     findings: string[],        // investigation.findings surfaced at top level
 *     actionCount: number,
 *     confidence: number | null, // classification confidence if available
 *     status: string,
 *     durationMs: number | null  // ms from creation to resolution/now
 *   }
 * }
 */
app.get('/api/incidents/:id', async (req: any, res: any) => {
  try {
    const incident = await incidentStore.getIncident(req.params.id);
    if (!incident) {
      return res.status(404).json({ success: false, error: 'Incident not found' });
    }

    const resolvedAt = incident.resolvedAt ?? null;
    const durationMs = resolvedAt
      ? resolvedAt.getTime() - incident.createdAt.getTime()
      : Date.now() - incident.createdAt.getTime();

    res.json({
      success: true,
      incident,
      summary: {
        findings: incident.investigation?.findings ?? [],
        actionCount: incident.actions.length,
        confidence: incident.investigation?.confidence ?? null,
        status: incident.status,
        durationMs,
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/approve — Resolve a proposal or kernel confirmation.
 *
 * Body variants:
 *   { incidentId: string, proposalId: string, approved: boolean }
 *     → resolves an ActionProposal; if approved, executes the action.
 *
 *   { confirmationId: string, approved: boolean }
 *     → resolves a kernel confirmation (like-me loop / tool execution).
 *
 *   { incidentId: string, approved: boolean }
 *     → legacy: grants/denies agent-runtime approval for an incident.
 *
 * All three forms can be combined in one request.
 */
app.post('/api/approve', async (req: any, res: any) => {
  try {
    // `always: true` also records "allow this tool always"; `scope: "root"`
    // records "allow this tool in this project root" — one-click standing
    // grants instead of approve-then-trust as two steps.
    const { incidentId, proposalId, confirmationId, approved, always, scope } = req.body as {
      incidentId?: string;
      proposalId?: string;
      confirmationId?: string;
      approved?: boolean;
      always?: boolean;
      scope?: string;
    };

    if (typeof approved !== 'boolean') {
      return res.status(400).json({ success: false, error: 'approved (boolean) is required' });
    }
    if (!incidentId && !confirmationId && !proposalId) {
      return res.status(400).json({
        success: false,
        error: 'At least one of incidentId, proposalId, or confirmationId is required',
      });
    }

    const result: Record<string, any> = { success: true, approved };

    // ── 1. Proposal resolution (primary Phase 2 path) ────────────────────────
    if (proposalId && incidentId) {
      const proposal = proposalStore.get(proposalId);
      if (!proposal) {
        return res.status(404).json({ success: false, error: `Proposal ${proposalId} not found` });
      }
      if (proposal.status !== 'pending') {
        return res.status(409).json({
          success: false,
          error: `Proposal ${proposalId} is already ${proposal.status}`,
        });
      }
      if (proposal.incidentId !== incidentId) {
        return res.status(400).json({
          success: false,
          error: `Proposal ${proposalId} belongs to incident ${proposal.incidentId}, not ${incidentId}`,
        });
      }

      if (!approved) {
        proposalStore.deny(proposalId, 'api');
        await proposalStore.auditDecision(proposal);
        await incidentStore.addAction(incidentId, {
          timestamp: new Date(),
          agent: 'api',
          action: 'proposal_denied',
          tool: proposal.tool,
          result: 'success',
          details: `Proposal ${proposalId} denied via API: ${proposal.action}`,
        });
        await incidentStore.addFinding(incidentId, `Proposal denied: "${proposal.action}". Incident remains open for manual review.`);
        result.proposal = proposalStore.get(proposalId);
        result.message = `Proposal ${proposalId} denied`;
      } else {
        // Approved — execute via DevOpsAgent
        const devopsAgent = agentRuntime.getAgent('devops-agent') as DevOpsAgent | undefined;
        if (!devopsAgent) {
          return res.status(503).json({ success: false, error: 'DevOpsAgent not registered' });
        }
        proposalStore.approve(proposalId, 'api');
        const execResult = await devopsAgent.executeApprovedProposal(proposalId, incidentId);
        result.proposal = proposalStore.get(proposalId);
        result.execution = execResult;
        result.message = execResult.success
          ? `Proposal ${proposalId} approved and executed: ${execResult.message}`
          : `Proposal ${proposalId} approved but execution failed: ${execResult.message}`;
        if (!execResult.success) result.success = false;
      }
    }

    // ── 2. Kernel confirmation (like-me loop) ────────────────────────────────
    if (confirmationId) {
      const trust = approved && always ? 'tool' as const : approved && scope === 'root' ? 'root' as const : undefined;
      const confirmation = likeMeLoop.approve(confirmationId, approved, trust ? { trust } : {});
      if (!confirmation) {
        return res.status(404).json({
          success: false,
          error: `Confirmation ${confirmationId} not found or already decided`,
        });
      }
      result.confirmation = confirmation;
      result.message = result.message ?? `Confirmation ${confirmationId} ${approved ? 'approved' : 'denied'}` +
        (trust === 'tool' ? ' + trusted always' : trust === 'root' ? ` + trusted in ${confirmation.scopePath ?? 'this root'}` : '');
    }

    // ── 3. Legacy agent-runtime approval ────────────────────────────────────
    if (incidentId && !proposalId) {
      if (approved) {
        await agentRuntime.grantApproval(incidentId);
      } else {
        await agentRuntime.denyApproval(incidentId);
      }
      result.message = result.message ?? `Incident ${incidentId} ${approved ? 'approved' : 'denied'}`;
    }

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/proposals — List pending proposals (optionally filtered by incidentId).
 * Query: ?incidentId=INC-xxx
 */
app.get('/api/proposals', (req: any, res: any) => {
  const { incidentId } = req.query as { incidentId?: string };
  const proposals = incidentId
    ? proposalStore.listByIncident(incidentId)
    : proposalStore.listPending();
  res.json({ success: true, count: proposals.length, proposals });
});

/**
 * POST /api/command - Emit a user command
 */
app.post('/api/command', async (req: any, res: any) => {
  try {
    const { command, userId = 'unknown', source = 'api' } = req.body;

    if (!command) {
      return res.status(400).json({
        success: false,
        error: 'command required',
      });
    }

    const result = await markRuntime.executeCommand(command, userId, source === 'voice' || source === 'cli' ? source : 'api');

    res.json({
      success: true,
      response: result.response,
      route: result.route,
      eventId: result.eventId,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/plan - Like-Me plan preview (never executes mutating steps)
 * Body: { goal: string, mode?: 'plan' | 'build' }
 */
app.post('/api/plan', async (req: any, res: any) => {
  try {
    const { goal, mode = 'plan' } = req.body as { goal?: string; mode?: LikeMeMode };

    if (!goal) {
      return res.status(400).json({ success: false, error: 'goal required' });
    }
    if (mode !== 'plan' && mode !== 'build') {
      return res.status(400).json({ success: false, error: "mode must be 'plan' or 'build'" });
    }

    await likeMeLoop.ensureInit();
    const preview = likeMeLoop.preview(goal, mode);
    res.json({ success: true, preview });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/execute - Like-Me execution (build mode is confirmation-gated)
 * Body: { goal: string, mode?: 'plan' | 'build', userId?: string, source?: 'api' | 'cli' | 'voice' }
 */
app.post('/api/execute', async (req: any, res: any) => {
  try {
    const { goal, mode = 'build', userId = config.defaultUser, source = 'api' } = req.body as {
      goal?: string;
      mode?: LikeMeMode;
      userId?: string;
      source?: 'api' | 'cli' | 'voice';
    };

    if (!goal) {
      return res.status(400).json({ success: false, error: 'goal required' });
    }

    const result = await likeMeLoop.execute(goal, { mode, userId, source });
    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/confirmations - List pending kernel confirmations
 */
app.get('/api/confirmations', (_req: any, res: any) => {
  res.json({ success: true, pending: likeMeLoop.listPending() });
});

/**
 * POST /api/confirmations - Approve/deny a kernel confirmation
 * Body: { confirmationId: string, approved: boolean, always?: boolean, scope?: "root" }
 */
app.post('/api/confirmations', (req: any, res: any) => {
  const { confirmationId, approved, always, scope } = req.body as {
    confirmationId?: string; approved?: boolean; always?: boolean; scope?: string;
  };
  if (!confirmationId || typeof approved !== 'boolean') {
    return res.status(400).json({ success: false, error: 'confirmationId and approved boolean required' });
  }
  const trust = approved && always ? 'tool' as const : approved && scope === 'root' ? 'root' as const : undefined;
  const record = likeMeLoop.approve(confirmationId, approved, trust ? { trust } : {});
  if (!record) {
    return res.status(404).json({ success: false, error: 'confirmation not found or already decided' });
  }
  res.json({ success: true, record });
});

/**
 * GET /api/health - Health check
 */
app.get('/api/health', (req: any, res: any) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/status/ops - Ops world-model snapshot: what MARK knows about its
 * environment. Composes incident, memory, baseline, and registry state.
 * Never 500s on a missing database: unavailable sections report degraded
 * with null data instead of failing the whole snapshot.
 */
app.get('/api/status/ops', async (req: any, res: any) => {
  const snapshot: Record<string, any> = { timestamp: new Date().toISOString(), degraded: [] as string[] };

  // Persistent objective: always present, never depends on the database.
  snapshot.objective = opsObjective.snapshot();

  try {
    const open = await incidentStore.getOpenIncidents();
    const bySeverity: Record<string, number> = {};
    const byRepo: Record<string, number> = {};
    for (const inc of open) {
      bySeverity[inc.severity] = (bySeverity[inc.severity] ?? 0) + 1;
      const repo = (inc.context as any)?.repository ?? 'unknown';
      byRepo[repo] = (byRepo[repo] ?? 0) + 1;
    }
    snapshot.openIncidents = { total: open.length, bySeverity };
    const baselines = await repoBaseline.list().catch(() => null);
    if (!baselines) {
      snapshot.degraded.push('baselines');
    }
    const repos = await repositoryRegistry.loadFromDatabase().catch(() => repositoryRegistry.list());
    snapshot.monitoredRepos = repos.map(r => {
      const base = baselines?.find(b => b.repository === r.fullName);
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
    snapshot.openIncidents = null;
    snapshot.monitoredRepos = null;
  }

  try {
    snapshot.autoFix = await opsMemory.overallFixRate(30);
  } catch {
    snapshot.degraded.push('autofix');
    snapshot.autoFix = null;
  }

  try {
    snapshot.mostCommonFailureThisWeek = await opsMemory.mostCommonFailureType(7);
  } catch {
    snapshot.degraded.push('failures');
    snapshot.mostCommonFailureThisWeek = null;
  }

  res.json({ success: true, ops: snapshot });
});

/**
 * GET /api/status - System status
 */
app.get('/api/status', async (req: any, res: any) => {
  try {
    const incidents = await incidentStore.getOpenIncidents();
    res.json({
      status: 'operational',
      openIncidents: incidents.length,
      criticalIncidents: incidents.filter(i => i.severity === 'critical').length,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({
      status: 'error',
      error: error.message,
    });
  }
});

/**
 * GET /api/status/ops — World model snapshot for the ops domain.
 *
 * Returns:
 * {
 *   openIncidents: { total, bySeverity },
 *   repoHealth: [{ repository, baseline, anomaly? }],
 *   autoFix: { attempts, successes, rate, mostCommonFailureType },
 *   anomalies: AnomalyReport[],
 *   selfKnowledge: { totalMemoryRecords, trustedFixTypes, kernelStatus }
 * }
 */
app.get('/api/status/ops', async (_req: any, res: any) => {
  try {
    const [
      openIncidents,
      baselines,
      anomalies,
      fixRate,
      mostCommonType,
    ] = await Promise.all([
      incidentStore.getOpenIncidents(),
      repoBaseline.list(),
      repoBaseline.detectAnomalies(),
      opsMemory.overallFixRate(30),
      opsMemory.mostCommonFailureType(7),
    ]);

    // Severity breakdown
    const bySeverity: Record<string, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    for (const inc of openIncidents) {
      bySeverity[inc.severity] = (bySeverity[inc.severity] ?? 0) + 1;
    }

    // Repo health — merge baselines with anomaly signals
    const anomalyMap = new Map(anomalies.map(a => [a.repository, a]));
    const repoHealth = baselines.map(b => ({
      repository: b.repository,
      avgIncidentsPerDay: b.avgIncidentsPerDay,
      avgResolutionMs: b.avgResolutionMs,
      mostCommonType: b.mostCommonType,
      totalIncidents: b.totalIncidents,
      lastUpdated: b.updatedAt,
      anomaly: anomalyMap.get(b.repository) ?? null,
    }));

    // Trusted fix types
    const trustedFixTypes: string[] = [];
    for (const type of ['MISSING_DEPENDENCY', 'LINT_FAILURE']) {
      if (await opsMemory.isTrusted(type)) trustedFixTypes.push(type);
    }

    // Self-knowledge: total memory records
    let totalMemoryRecords = 0;
    try {
      const { getPool } = await import('../db/postgres.js');
      const r = await getPool().query<{ n: string }>('SELECT COUNT(*)::int AS n FROM ops_incident_memory');
      totalMemoryRecords = Number(r.rows[0]?.n ?? 0);
    } catch { /* DB may be offline */ }

    const kernelStatus = markRuntime.kernelStatus();

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      openIncidents: {
        total: openIncidents.length,
        bySeverity,
      },
      repoHealth,
      anomalies,
      autoFix: {
        attempts: fixRate.attempts,
        successes: fixRate.successes,
        rate: Math.round(fixRate.rate * 1000) / 10, // percentage with 1dp
        mostCommonFailureTypeThisWeek: mostCommonType,
      },
      selfKnowledge: {
        totalMemoryRecords,
        trustedFixTypes,
        kernelInitialized: kernelStatus.initialized,
        kernelToolCount: kernelStatus.availableTools.length,
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────────────────────
const PORT = process.env.API_PORT || 3001;
if (!config.databaseUrl) {
  console.warn(
    '[MARK] WARNING: DATABASE_URL is not set — incidents, memory, baselines, and confirmations ' +
    'will silently no-op (in-memory only). Set it in .env to persist anything. ' +
    'See app/Scripts/migrations + npm run db:migrate.',
  );
}
if (config.markTestMode) {
  console.warn('[MARK] WARNING: MARK_TEST_MODE is on — jail bypassed, confirmations auto-approved. Testing only.');
}
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
    ╔═══════════════════════════════════════╗
    ║    🤖 MARK v0.2 Autonomous Operations ║
    ║           API Server Started          ║
    ╠═══════════════════════════════════════╣
    ║  Port: ${PORT}                          ║
    ║  Event Bus: Active                    ║
    ║  Agents: Ready                         ║
    ╚═══════════════════════════════════════╝
  `);
});
