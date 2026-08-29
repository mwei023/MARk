/**
 * Incident Model: Tracks operational problems and their resolution.
 * Replaces conversation history - focuses on what happened, what was tried, outcome.
 */

import { getPool } from '../db/postgres';

export type IncidentSeverity = 'low' | 'medium' | 'high' | 'critical';
export type IncidentStatus = 'open' | 'investigating' | 'resolved' | 'escalated';

export interface IncidentAction {
  timestamp: Date;
  agent: string; // Which agent took the action
  action: string; // What was done
  tool: string; // Which tool was used
  args?: Record<string, any>;
  result: 'success' | 'failure';
  details: string;
}

export interface Incident {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  
  // Core
  title: string;
  description: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  
  // Trigger
  triggerEvent: string; // Event type that triggered this
  triggerEventId: string; // Event ID
  correlationId: string; // Links all related events
  
  // Assignment
  assignedAgent: string; // Which agent is handling this
  tags: string[]; // Category tags: 'build-failure', 'deployment', 'health', etc
  
  // Context
  context: {
    repository?: string;
    branch?: string;
    commit?: string;
    environment?: string;
    service?: string;
    [key: string]: any;
  };
  
  // Investigation
  investigation?: {
    findings: string[];
    hypothesis?: string;
    bloomingConfidence?: number; // 0-1: how confident are we?
  };
  
  // Actions taken
  actions: IncidentAction[];
  
  // Resolution
  resolvedAt?: Date;
  resolution?: {
    action: string;
    success: boolean;
    details: string;
  };
  
  // LLM reasoning (if invoked)
  aiAnalysis?: {
    invokedAt: Date;
    prompt: string;
    response: string;
    modelUsed: string;
  };
}

/**
 * Incident Store: Persistent storage and retrieval
 */
export class IncidentStore {
  async createIncident(incident: Omit<Incident, 'id' | 'createdAt' | 'updatedAt' | 'actions'>): Promise<Incident> {
    const pool = getPool();
    const id = `INC-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const now = new Date();

    await pool.query(`
      INSERT INTO incidents (
        id, created_at, updated_at, title, description, severity, status,
        trigger_event, trigger_event_id, correlation_id, assigned_agent,
        tags, context
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    `, [
      id, now, now, incident.title, incident.description, incident.severity,
      incident.status, incident.triggerEvent, incident.triggerEventId,
      incident.correlationId, incident.assignedAgent,
      JSON.stringify(incident.tags), JSON.stringify(incident.context),
    ]);

    return {
      id,
      createdAt: now,
      updatedAt: now,
      actions: [],
      ...incident,
    };
  }

  async getIncident(id: string): Promise<Incident | null> {
    const pool = getPool();
    const result = await pool.query('SELECT * FROM incidents WHERE id = $1', [id]);
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    const actions = await this.getActions(id);

    return {
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      title: row.title,
      description: row.description,
      severity: row.severity,
      status: row.status,
      triggerEvent: row.trigger_event,
      triggerEventId: row.trigger_event_id,
      correlationId: row.correlation_id,
      assignedAgent: row.assigned_agent,
      tags: row.tags,
      context: row.context,
      investigation: row.investigation,
      actions,
      resolvedAt: row.resolved_at,
      resolution: row.resolution,
      aiAnalysis: row.ai_analysis,
    };
  }

  async addAction(incidentId: string, action: IncidentAction): Promise<void> {
    const pool = getPool();
    await pool.query(`
      INSERT INTO incident_actions (incident_id, timestamp, agent, action, tool, args, result, details)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      incidentId,
      action.timestamp,
      action.agent,
      action.action,
      action.tool,
      JSON.stringify(action.args || {}),
      action.result,
      action.details,
    ]);

    // Update incident updated_at
    await pool.query('UPDATE incidents SET updated_at = NOW() WHERE id = $1', [incidentId]);
  }

  async updateStatus(incidentId: string, status: IncidentStatus): Promise<void> {
    const pool = getPool();
    await pool.query('UPDATE incidents SET status = $1, updated_at = NOW() WHERE id = $2', [status, incidentId]);
  }

  async resolveIncident(incidentId: string, resolution: Incident['resolution']): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE incidents SET status = 'resolved', resolved_at = NOW(), resolution = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(resolution), incidentId]
    );
  }

  private async getActions(incidentId: string): Promise<IncidentAction[]> {
    const pool = getPool();
    const result = await pool.query(
      'SELECT * FROM incident_actions WHERE incident_id = $1 ORDER BY timestamp ASC',
      [incidentId]
    );
    return result.rows.map(row => ({
      timestamp: row.timestamp,
      agent: row.agent,
      action: row.action,
      tool: row.tool,
      args: row.args,
      result: row.result,
      details: row.details,
    }));
  }

  async getOpenIncidents(): Promise<Incident[]> {
    const pool = getPool();
    const result = await pool.query(`
      SELECT * FROM incidents WHERE status != 'resolved' ORDER BY created_at DESC
    `);
    
    const incidents: Incident[] = [];
    for (const row of result.rows) {
      const actions = await this.getActions(row.id);
      incidents.push({
        id: row.id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        title: row.title,
        description: row.description,
        severity: row.severity,
        status: row.status,
        triggerEvent: row.trigger_event,
        triggerEventId: row.trigger_event_id,
        correlationId: row.correlation_id,
        assignedAgent: row.assigned_agent,
        tags: row.tags,
        context: row.context,
        investigation: row.investigation,
        actions,
        resolvedAt: row.resolved_at,
        resolution: row.resolution,
      });
    }
    return incidents;
  }
}

export const incidentStore = new IncidentStore();
