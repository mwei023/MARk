import {
  DiscoveryProvider,
  ToolDescriptor,
  ToolImplementation,
} from '../index';
import { incidentStore } from '../../core/incident';

export const incidentListOpenTool: ToolDescriptor = {
  id: 'incident.list_open',
  name: 'List open incidents',
  description: 'Lists unresolved operational incidents: builds, deployments, and CI triage tracked by MARK.',
  version: '1.0.0',
  domain: 'incidents',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum incidents to return (1-50, default 20).' },
    },
    required: [],
  },
  outputSchema: {
    type: 'object',
    properties: {
      count: { type: 'number' },
      incidents: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            severity: { type: 'string' },
            status: { type: 'string' },
            assignedAgent: { type: 'string' },
            createdAt: { type: 'string' },
          },
          required: ['id', 'title', 'severity', 'status', 'assignedAgent', 'createdAt'],
        },
      },
      capturedAt: { type: 'string' },
    },
    required: ['count', 'incidents', 'capturedAt'],
  },
  capabilities: ['incident-listing', 'operations-awareness'],
  supportedResourceKinds: ['unknown'],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'ops.incidents',
};

export const incidentListOpenImplementation: ToolImplementation = {
  toolId: incidentListOpenTool.id,

  async execute({ action }) {
    const requested = typeof action.input.limit === 'number' ? Math.floor(action.input.limit) : 20;
    const limit = Math.min(Math.max(requested, 1), 50);
    const open = await incidentStore.getOpenIncidents();
    const sliced = open.slice(0, limit);
    const output = {
      count: sliced.length,
      incidents: sliced.map(incident => ({
        id: incident.id,
        title: incident.title,
        severity: incident.severity,
        status: incident.status,
        assignedAgent: incident.assignedAgent,
        createdAt: new Date(incident.createdAt).toISOString(),
      })),
      capturedAt: new Date().toISOString(),
    };
    return {
      output,
      observations: [
        {
          id: `observation-${Date.now()}`,
          kind: 'output',
          source: 'ops.incidents',
          subject: 'open-incidents',
          summary: `${sliced.length} open incident(s).`,
          data: output,
          confidence: 1,
          observedAt: output.capturedAt,
          relatedResourceIds: [],
        },
      ],
    };
  },
};

export const incidentGetTool: ToolDescriptor = {
  id: 'incident.get',
  name: 'Get incident details',
  description: 'Returns one incident with its action trail by id. Use after incident.list_open.',
  version: '1.0.0',
  domain: 'incidents',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Incident id, e.g. INC-....' },
    },
    required: ['id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      incident: { type: 'object' },
      actionCount: { type: 'number' },
      capturedAt: { type: 'string' },
    },
    required: ['incident', 'actionCount', 'capturedAt'],
  },
  capabilities: ['incident-inspection', 'operations-awareness'],
  supportedResourceKinds: ['unknown'],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'ops.incidents',
};

export const incidentGetImplementation: ToolImplementation = {
  toolId: incidentGetTool.id,

  async execute({ action }) {
    const id = String(action.input.id ?? '').trim();
    if (!id) throw new Error('Incident id is required.');
    const incident = await incidentStore.getIncident(id);
    if (!incident) throw new Error(`Incident "${id}" not found.`);
    const output = {
      incident: JSON.parse(JSON.stringify(incident)) as Record<string, unknown>,
      actionCount: incident.actions.length,
      capturedAt: new Date().toISOString(),
    };
    return {
      output,
      observations: [
        {
          id: `observation-${Date.now()}`,
          kind: 'output',
          source: 'ops.incidents',
          subject: id,
          summary: `Read incident ${id} (${incident.actions.length} recorded action(s)).`,
          data: { id, actionCount: incident.actions.length },
          confidence: 1,
          observedAt: output.capturedAt,
          relatedResourceIds: [],
        },
      ],
    };
  },
};

export const incidentTools: ToolDescriptor[] = [incidentListOpenTool, incidentGetTool];

export const incidentImplementations: ToolImplementation[] = [
  incidentListOpenImplementation,
  incidentGetImplementation,
];

export const incidentDiscoveryProvider: DiscoveryProvider = {
  id: 'ops.incidents',
  name: 'Incident store provider',
  description: 'Exposes MARK incident memory (open incidents, action trails) as read-only tools.',
  priority: 90,

  async isAvailable(): Promise<boolean> {
    return true;
  },

  async discoverResources(): Promise<never[]> {
    return [];
  },

  async discoverTools(): Promise<ToolDescriptor[]> {
    return incidentTools;
  },
};
