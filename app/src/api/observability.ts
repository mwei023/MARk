/**
 * Observability APIs: real-time projection of MARK's existing runtime.
 *
 * Every payload here is backed by an actual MARK source — no invented
 * runtime behavior:
 * - GET /api/events/stream ........ live EventBus (subscribeAll) as SSE
 * - GET /api/interactions ......... interactionStream.list() (mark-runtime traces)
 * - GET /api/kernel/status ........ markRuntime.kernelStatus()
 * - GET /api/kernel/tools ......... markRuntime.listKernelTools()
 *
 * Poll-based sources (incidents, proposals, confirmations, ops snapshot,
 * health, status) already exist on server-v2 and are consumed directly by
 * the Control Room / Playground clients.
 */
import { eventBus } from '../core/event-bus';
import type { Event } from '../core/events';
import { interactionStream } from '../core/interaction';
import { markRuntime } from '../core/mark-runtime';

// server-v2 uses untyped express handlers ((req: any, res: any)) — this
// module matches that style (no @types/express in devDeps).

/** SSE wire shape for one bus event. Field-for-field from the real Event. */
export interface BusEventFrame {
  id: string;
  timestamp: string;
  source: Event['source'];
  type: Event['type'];
  severity: Event['severity'];
  correlationId?: string;
  data: Record<string, unknown>;
}

export function toBusEventFrame(event: Event): BusEventFrame {
  return {
    id: event.id,
    timestamp: event.timestamp instanceof Date
      ? event.timestamp.toISOString()
      : String(event.timestamp),
    source: event.source,
    type: event.type,
    severity: event.severity,
    correlationId: event.correlationId,
    data: (event.data ?? {}) as Record<string, unknown>,
  };
}

/** User command payloads are private to their interaction session. Operational
 * events remain global because they describe the shared host/environment. */
export function eventVisibleToSession(event: Event, sessionId: string): boolean {
  if (event.type !== 'user.command.received') return true;
  const data = (event.data ?? {}) as Record<string, unknown>;
  return String(data.sessionId ?? 'default') === (sessionId.trim() || 'default');
}

function writeSse(res: any, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function registerObservabilityRoutes(app: any): void {
  /**
   * GET /api/events/stream — live EventBus as SSE.
   *
   * Emits `{ hello, eventTypes }` on connect, then one
   * `{ event: BusEventFrame }` frame per bus event, plus `: ping`
   * heartbeats every 25s so proxies do not close idle streams.
   */
  app.get('/api/events/stream', (req: any, res: any) => {
    const sessionId = String(req.query?.sessionId ?? req.headers?.['x-mark-session-id'] ?? 'default').slice(0, 128);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // Express + proxies buffer SSE unless flushed explicitly.
    const flush = (res as unknown as { flushHeaders?: () => void }).flushHeaders;
    if (typeof flush === 'function') flush.call(res);

    writeSse(res, { hello: true, at: new Date().toISOString() });

    const unsubscribe = eventBus.subscribeAll((event: Event) => {
      if (!eventVisibleToSession(event, sessionId)) return;
      try {
        writeSse(res, { event: toBusEventFrame(event), sessionId });
      } catch {
        // One slow client must never break the bus.
      }
    });

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        // Client gone — cleanup below handles it.
      }
    }, 25_000);

    const close = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on('close', close);
    // Avoid leaking a 25s timer per client beyond the response lifetime.
    res.on('close', close);
  });

  /**
   * GET /api/interactions — the conversation/trace stream every transport
   * renders (message, approval, trace, receipt, thinking). Written by
   * mark-runtime executeCommand; read here for the Control Room trace view.
   * Query: ?limit=200 (default 200, max 500 — the stream retains 500).
   */
  app.get('/api/interactions', (req: any, res: any) => {
    try {
      const raw = Number((req.query as { limit?: string }).limit ?? 200);
      const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 500) : 200;
      const sessionId = String(req.query?.sessionId ?? req.headers?.['x-mark-session-id'] ?? 'default').slice(0, 128);
      const events = interactionStream.list(sessionId).slice(-limit);
      res.json({ success: true, sessionId, count: events.length, thinkingOn: interactionStream.isThinkingOn(sessionId), events });
    } catch (error: unknown) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  /**
   * GET /api/kernel/status — kernel init state + discovered/available tools.
   * Direct read of markRuntime.kernelStatus(); never throws by contract of
   * the bridge (degrades to initialized:false when the kernel is down).
   */
  app.get('/api/kernel/status', (_req: any, res: any) => {
    try {
      res.json({ success: true, ...markRuntime.kernelStatus() });
    } catch (error: unknown) {
      res.json({ success: false, initialized: false, discoveredTools: [], availableTools: [] });
    }
  });

  /**
   * GET /api/kernel/tools — discovered tool descriptors (id, risk, describe).
   * Direct read of markRuntime.listKernelTools(); empty list when the
   * kernel has not initialized (DB offline, discovery error).
   */
  app.get('/api/kernel/tools', (_req: any, res: any) => {
    try {
      const tools = markRuntime.listKernelTools().map(t => ({
        id: t.id,
        risk: (t as { risk?: string }).risk ?? 'unknown',
        description: (t as { description?: string }).description ?? '',
      }));
      res.json({ success: true, count: tools.length, tools });
    } catch (error: unknown) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}
