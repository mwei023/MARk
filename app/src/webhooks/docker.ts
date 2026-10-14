/**
 * Docker Webhook Handler: Receives Docker/container events and converts them
 * to internal MARK events. Pairs with the DevOpsAgent.
 *
 * Accepts Docker daemon webhook payloads (`container_die`, `health_status`)
 * and a minimal JSON form: { container, status, service }.
 */
import { Request, Response } from 'express';
import { EventBus } from '../core/event-bus';
import { Event } from '../core/events';

export class DockerWebhookHandler {
  constructor(private eventBus: EventBus) {}

  handler() {
    return async (req: Request, res: Response) => {
      try {
        const payload = (req.body ?? {}) as Record<string, any>;
        const events = this.parseDockerEvent(payload);
        for (const event of events) {
          await this.eventBus.emit(event);
        }
        res.status(200).json({ status: 'received', events: events.length });
      } catch (error) {
        console.error('[Docker Webhook] Parse error:', error);
        res.status(400).json({ error: 'Invalid payload' });
      }
    };
  }

  private parseDockerEvent(payload: Record<string, any>): Event[] {
    const type = String(payload.Type || payload.type || '').toLowerCase();
    const action = String(payload.Action || payload.action || payload.status || '').toLowerCase();
    const actor = (payload.Actor?.Attributes ?? payload.actor ?? {}) as Record<string, any>;
    const container = String(
      payload.container || payload.containerName || actor.name || actor.container || 'unknown-container',
    );
    const service = String(payload.service || actor['com.docker.compose.service'] || container);

    const base = {
      id: `DK-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date(),
      source: 'docker' as const,
      severity: 'warning' as const,
      correlationId: container,
    };

    if (type.includes('container') && (action.includes('die') || action.includes('exit'))) {
      return [{
        ...base,
        type: 'docker.container.exited',
        data: { containerId: payload.id || container, containerName: container, service, status: action },
      }];
    }

    if (
      action.includes('unhealthy') ||
      action.includes('health') ||
      String(payload.health_status || payload.health || '').toLowerCase().includes('unhealthy')
    ) {
      return [{
        ...base,
        type: 'docker.container.health_status.unhealthy',
        data: {
          containerId: payload.id || container,
          containerName: container,
          service,
          lastHealthStatus: 'unhealthy',
          timestamp: new Date(),
        },
      }];
    }

    if (action.includes('healthy') || action.includes('start') || action.includes('restart')) {
      return [{
        ...base,
        severity: 'info' as const,
        type: 'docker.service.restarted',
        data: { containerId: payload.id || container, containerName: container, service, status: action },
      }];
    }

    if (payload.container || payload.containerName) {
      return [{
        ...base,
        type: 'docker.container.health_status.unhealthy',
        data: {
          containerId: payload.id || container,
          containerName: container,
          service,
          lastHealthStatus: String(payload.status || 'unknown'),
          timestamp: new Date(),
        },
      }];
    }

    return [];
  }
}
