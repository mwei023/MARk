/**
 * Mark API Server v2.0
 * Event-driven architecture with autonomous agents.
 *
 * Routes:
 * POST /webhooks/github  - GitHub events
  * POST /webhooks/docker  - Docker/container events
  * POST /webhooks/edge    - Edge TinyML-node events (MQTT bridge)
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
import { incidentStore } from '../core/incident';
import { agentRuntime } from '../core/agent-runtime';
import { GitHubWebhookHandler } from '../webhooks/github';
import { DockerWebhookHandler } from '../webhooks/docker';
import { EdgeWebhookHandler } from '../webhooks/edge';
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
import { buildOpsSnapshot } from './ops-snapshot';
import { registerObservabilityRoutes } from './observability';
import { resolveApiSecurity } from './security';
import { confirmationManager } from '../kernel/confirmations';

// Env files are loaded centrally in config.ts (before it snapshots
// process.env) — no per-entry dotenv calls needed here.
import * as path from 'path';

const app = express();
app.use(express.json({
  verify: (req: any, _res: any, buf: any) => {
    req.rawBody = buf;
  },
}));

// CORS for browser clients (the static chat UI is served from another
// origin/port). Preflight is answered before auth so browsers proceed.
app.use((req: any, res: any, next: any) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-token');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

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
const edgeHandler = new EdgeWebhookHandler(eventBus);
app.post('/webhooks/edge', edgeHandler.handler());

// Static observability clients (Control Room + Playground share one stream).
// Served from app/mark-os-site so the UI ships with the API it observes.
app.use('/ui', express.static(path.join(__dirname, '../../mark-os-site')));

// Real-time observability: live event stream + interaction/kernel snapshots.
registerObservabilityRoutes(app);

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
    await proposalStore.loadFromDatabase();
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
      if (!approved) {
        const confirmation = likeMeLoop.approve(confirmationId, false);
        if (!confirmation) {
          return res.status(404).json({
            success: false,
            error: `Confirmation ${confirmationId} not found or already decided`,
          });
        }
        result.confirmation = confirmation;
        result.message = result.message ?? `Confirmation ${confirmationId} denied`;
      } else {
        // Approve AND resume so one call finishes the job.
        const resumed = await likeMeLoop.approveAndResume(confirmationId, 'api', trust ? { trust } : {});
        if (!resumed) {
          return res.status(404).json({
            success: false,
            error: `Confirmation ${confirmationId} not found or already decided`,
          });
        }
        result.confirmation = resumed.record;
        result.execution = resumed.result;
        result.message = result.message ?? `Confirmation ${confirmationId} approved → ${(resumed.result as { status?: string }).status}` +
          (trust === 'tool' ? ' + trusted always' : trust === 'root' ? ` + trusted in ${(resumed.record as { scopePath?: string }).scopePath ?? 'this root'}` : '');
      }
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

    await proposalStore.flush();
    await confirmationManager.flush();
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/proposals — List pending proposals (optionally filtered by incidentId).
 * Query: ?incidentId=INC-xxx
 */
app.get('/api/proposals', async (req: any, res: any) => {
  await proposalStore.loadFromDatabase();
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
    // Existing local UIs omit a session id and share the deliberate
    // single-user default. Multi-session clients must provide one explicitly
    // in the body or X-Mark-Session-Id header.
    const sessionId = String(req.body?.sessionId ?? req.headers?.['x-mark-session-id'] ?? 'default').slice(0, 128);

    if (!command) {
      return res.status(400).json({
        success: false,
        error: 'command required',
      });
    }

    const result = await markRuntime.executeCommand(command, userId, source === 'voice' || source === 'cli' ? source : 'api', { sessionId });

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
 * POST /api/command/stream - Same as /api/command but streams reasoning
 * tokens as SSE (`data: {"token": "..."}`), then a final
 * `data: {"done": true, ...}` frame with route/eventId/response.
 * Non-reasoning routes emit zero token frames and one done frame, so every
 * client can consume one protocol unconditionally.
 */
app.post('/api/command/stream', async (req: any, res: any) => {
  try {
    const { command, userId = 'unknown', source = 'api' } = req.body;
    const sessionId = String(req.body?.sessionId ?? req.headers?.['x-mark-session-id'] ?? 'default').slice(0, 128);

    if (!command) {
      return res.status(400).json({
        success: false,
        error: 'command required',
      });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const send = (payload: unknown): void => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      const result = await markRuntime.executeCommand(
        command,
        userId,
        source === 'voice' || source === 'cli' ? source : 'api',
        { sessionId, onToken: (token) => send({ token }) },
      );
      send({ done: true, success: true, response: result.response, route: result.route, eventId: result.eventId });
    } catch (error: any) {
      send({ done: true, success: false, error: error.message });
    }
    res.end();
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});
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
app.post('/api/confirmations', async (req: any, res: any) => {
  const { confirmationId, approved, always, scope } = req.body as {
    confirmationId?: string; approved?: boolean; always?: boolean; scope?: string;
  };
  if (!confirmationId || typeof approved !== 'boolean') {
    return res.status(400).json({ success: false, error: 'confirmationId and approved boolean required' });
  }
  const trust = approved && always ? 'tool' as const : approved && scope === 'root' ? 'root' as const : undefined;
  if (!approved) {
    const record = likeMeLoop.approve(confirmationId, false);
    if (!record) {
      return res.status(404).json({ success: false, error: 'confirmation not found or already decided' });
    }
    res.json({ success: true, record });
    return;
  }
  const resumed = await likeMeLoop.approveAndResume(confirmationId, 'api', trust ? { trust } : {});
  if (!resumed) {
    return res.status(404).json({ success: false, error: 'confirmation not found or already decided' });
  }
  res.json({ success: true, record: resumed.record, result: resumed.result });
});

/**
 * POST /api/research - Fire an exhaustive deep-research run
 * Body: { topic?: string, query?: string, depth?: 'standard' | 'deep' | 'exhaustive', fileGaps?: boolean }
 *
 * Returns 202 immediately with the tracking incident id; the ResearchAgent
 * works the loop asynchronously and lands findings + problem-statement
 * incidents on the trail. Poll GET /api/incidents/:id for the report.
 */
app.post('/api/research', async (req: any, res: any) => {
  try {
    const { topic, query, depth = 'deep', fileGaps = true } = req.body as {
      topic?: string; query?: string; depth?: string; fileGaps?: boolean;
    };
    const cleanTopic = String(topic ?? query ?? '').trim().slice(0, 300);
    if (!cleanTopic) {
      return res.status(400).json({ success: false, error: 'topic (or query) required' });
    }
    if (depth !== 'standard' && depth !== 'deep' && depth !== 'exhaustive') {
      return res.status(400).json({ success: false, error: "depth must be 'standard', 'deep', or 'exhaustive'" });
    }
    const incident = await incidentStore.createIncident({
      title: `Deep research: ${cleanTopic.slice(0, 140)}`,
      description: `Exhaustive ${depth} research requested via API.`,
      severity: 'low',
      status: 'investigating',
      triggerEvent: 'research.requested',
      triggerEventId: `RES-${Date.now()}`,
      correlationId: `research:${cleanTopic.slice(0, 80)}`,
      assignedAgent: 'research-agent',
      tags: ['research', depth],
      context: { researchTopic: cleanTopic, depth },
    });
    await eventBus.emit({
      id: `EVT-${Date.now()}`,
      timestamp: new Date(),
      source: 'api',
      type: 'research.requested',
      severity: 'info',
      correlationId: incident.correlationId,
      data: { topic: cleanTopic, depth, fileGaps, incidentId: incident.id },
    } as any);
    res.status(202).json({ success: true, incidentId: incident.id, topic: cleanTopic, depth });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
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
 * environment. Single canonical handler (see ops-snapshot.ts): the phase-3
 * shape (openIncidents, repoHealth, anomalies, autoFix, selfKnowledge)
 * with degraded-mode resilience (sections fail to null independently,
 * never a 500). Previously registered twice — the second res.json
 * crashed every request with headers-already-sent.
 */
app.get('/api/status/ops', async (_req: any, res: any) => {
  try {
    const snapshot = await buildOpsSnapshot();
    res.json({ success: true, ...snapshot });
  } catch (error: any) {
    // buildOpsSnapshot never throws by contract; this is belt and braces.
    res.status(500).json({ success: false, error: error?.message ?? 'snapshot failed' });
  }
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

// ─────────────────────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────────────────────
const PORT = process.env.API_PORT || 3001;
// Security boundary (see api/security.ts): loopback bind by default,
// fail fast on an open API in production.
const apiSecurity = resolveApiSecurity({
  nodeEnv: config.nodeEnv,
  apiToken: config.apiToken,
  bindHost: config.apiBindHost,
  allowUnauthenticatedApi: config.allowUnauthenticatedApi,
  githubWebhookSecret: config.githubWebhookSecret,
});
for (const warning of apiSecurity.warnings) {
  console.warn(warning);
}
if (apiSecurity.fatal) {
  console.error(apiSecurity.fatal);
  process.exit(1);
}
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
app.listen(PORT, apiSecurity.bindHost, () => {
  void proposalStore.loadFromDatabase();
  void markRuntime.initializeKernel();
  console.log(`
    ╔═══════════════════════════════════════╗
    ║    🤖 MARK v0.2 Autonomous Operations ║
    ║           API Server Started          ║
    ╠═══════════════════════════════════════╣
    ║  Bind: ${apiSecurity.bindHost}:${PORT}${apiSecurity.authMode === 'open' ? ' (OPEN API — localhost only)' : ' (token auth)'}  ║
    ║  Event Bus: Active                    ║
    ║  Agents: Ready                         ║
    ╚═══════════════════════════════════════╝
  `);
});
