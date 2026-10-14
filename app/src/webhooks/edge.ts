/**
 * Edge Webhook Handler: receives TinyML-node events via an MQTT bridge
 * and converts them to internal MARK events. Pairs with the DevOpsAgent
 * (physical ops triage) the way Docker webhooks already do.
 *
 * Minimal JSON form from the bridge: { node, event, battery, detail }.
 * event ∈ { obstacle, low_batt, wake, node_online }.
 */
import { Request, Response } from 'express';
import { EventBus } from '../core/event-bus';
import { Event } from '../core/events';

export class EdgeWebhookHandler {
  constructor(private eventBus: EventBus) {}

  handler() {
    return async (req: Request, res: Response) => {
      try {
        const payload = (req.body ?? {}) as Record<string, any>;
        const events = this.parseEdgeEvent(payload);
        for (const event of events) {
          await this.eventBus.emit(event);
        }
        res.status(200).json({ status: 'received', events: events.length });
      } catch (error) {
        console.error('[Edge Webhook] Parse error:', error);
        res.status(400).json({ error: 'Invalid payload' });
      }
    };
  }

  parseEdgeEvent(payload: Record<string, any>): Event[] {
    const node = String(payload.node || payload.device || payload.hostname || 'unknown-node');
    const raw = String(payload.event || payload.type || '').toLowerCase();
    const battery = Number(payload.battery ?? payload.batt ?? NaN);

    const base = {
      id: `EDGE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date(),
      source: 'edge' as const,
      correlationId: node,
    };

    if (raw.includes('obstacle')) {
      return [{
        ...base,
        type: 'edge.obstacle',
        severity: 'warning' as const,
        data: { node, detail: String(payload.detail || payload.distance || 'obstacle detected') },
      }];
    }

    if (raw.includes('low_batt') || raw.includes('lowbatt') || raw.includes('battery')) {
      const critical = !Number.isNaN(battery) && battery < 10;
      return [{
        ...base,
        type: 'edge.low_batt',
        severity: critical ? 'critical' as const : 'warning' as const,
        data: { node, battery: Number.isNaN(battery) ? undefined : battery },
      }];
    }

    if (raw.includes('wake')) {
      return [{
        ...base,
        type: 'edge.wake',
        severity: 'info' as const,
        data: { node, detail: String(payload.detail || 'wake word') },
      }];
    }

    if (raw.includes('online') || raw.includes('hello') || raw.includes('boot')) {
      return [{
        ...base,
        type: 'edge.node.online',
        severity: 'info' as const,
        data: { node, manifest: payload.manifest },
      }];
    }

    return [];
  }
}
