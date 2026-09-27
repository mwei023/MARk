/** Phase 3 merge proof: edge event -> devops-agent -> incident + audit. */
import { describe, it, expect, beforeEach } from 'vitest';
import { Gateway } from '../core/gateway.js';
import { DevOpsAgent } from '../agents/devops-agent.js';
import { EdgeWebhookHandler } from './edge.js';
import { incidentStore } from '../core/incident.js';

describe('edge webhook parse', () => {
  it('maps obstacle / low_batt / wake / online payloads', () => {
    const h = new EdgeWebhookHandler({ emit: async () => {} } as any);
    const [ob] = h.parseEdgeEvent({ node: 'pi-rover', event: 'obstacle', detail: '12cm' });
    expect(ob.type).toBe('edge.obstacle');
    expect(ob.severity).toBe('warning');
    expect(ob.correlationId).toBe('pi-rover');

    const [lb] = h.parseEdgeEvent({ node: 'pi-rover', event: 'low_batt', battery: 7 });
    expect(lb.type).toBe('edge.low_batt');
    expect(lb.severity).toBe('critical');

    const [w] = h.parseEdgeEvent({ node: 'esp32-door', event: 'wake' });
    expect(w.type).toBe('edge.wake');

    const [on] = h.parseEdgeEvent({ node: 'esp32-door', event: 'node_online' });
    expect(on.type).toBe('edge.node.online');

    expect(h.parseEdgeEvent({ node: 'x', event: 'nonsense' })).toEqual([]);
  });
});

describe('edge routing', () => {
  it('sends obstacle + low_batt to devops-agent, wake stays informational', () => {
    const gw = new Gateway();
    const ob: any = { id: 'e', timestamp: new Date(), source: 'edge', type: 'edge.obstacle', severity: 'warning', data: {} };
    const d1 = gw.classify(ob);
    expect(d1.path).toBe('agent');
    expect(d1.agent).toBe('devops-agent');

    const lb: any = { ...ob, type: 'edge.low_batt', severity: 'critical' };
    const d2 = gw.classify(lb);
    expect(d2.path).toBe('agent');
    expect(d2.priority).toBe('critical');

    const w: any = { ...ob, type: 'edge.wake', severity: 'info' };
    expect(gw.classify(w).path).toBe('deterministic');

    expect(new DevOpsAgent().canHandle(ob)).toBe(true);
  });
});

describe('edge obstacle -> incident workflow', () => {
  const incidents: any[] = [];
  beforeEach(() => { incidents.length = 0; });

  it('creates incident with audit actions and open status', async () => {
    const store = incidentStore as any;
    const origFind = store.findOrCreateIncident?.bind(store);
    const origAdd = store.addAction.bind(store);
    const origStatus = store.updateStatus.bind(store);
    store.findOrCreateIncident = async (input: any) => {
      const inc = { id: `INC-EDGE-${incidents.length + 1}`, status: 'new', actions: [], ...input };
      incidents.push(inc);
      return inc;
    };
    store.addAction = async (id: string, action: any) => {
      incidents.find(i => i.id === id)?.actions.push(action);
    };
    store.updateStatus = async (id: string, status: any) => {
      const inc = incidents.find(i => i.id === id);
      if (inc) inc.status = status;
    };
    try {
      const h = new EdgeWebhookHandler({ emit: async () => {} } as any);
      const [ev] = h.parseEdgeEvent({ node: 'pi-rover', event: 'obstacle', detail: '12cm' });
      await new DevOpsAgent().handle(ev as any);
      expect(incidents.length).toBe(1);
      expect(incidents[0].triggerEvent).toBe('edge.obstacle');
      expect(incidents[0].assignedAgent).toBe('devops-agent');
      expect(incidents[0].context.service).toBe('pi-rover');
      expect(incidents[0].actions.length).toBeGreaterThanOrEqual(1);
      expect(incidents[0].status).toBe('open');
    } finally {
      if (origFind) store.findOrCreateIncident = origFind;
      store.addAction = origAdd;
      store.updateStatus = origStatus;
    }
  });
});
