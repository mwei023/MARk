/**
 * Incident Model — persistent storage and retrieval.
 *
 * Phase 1 additions:
 * - findOrCreateIncident: correlation before creation — repeated events append to
 *   existing open incidents instead of creating duplicates.
 * - addFinding: write investigation findings back to the incident's investigation.findings[]
 * - Escalation audit log: when an incident reaches 'escalated', a JSON line is
 *   appended to app/audit.log for external consumption.
 */

import { getPool } from '../db/postgres';
import { appendFile } from 'fs/promises';
import { join } from 'path';

export type IncidentSeverity = 'low' | 'medium' | 'high' | 'critical';
export type IncidentStatus = 'open' | 'investigating' | 'resolved' | 'escalated';

export interface IncidentAction {
  timestamp: Date;
  agent: string;
  action: string;
  tool: string;
  args?: Record<string, any>;
  result: 'success' | 'failure';
  details: string;
}

export interface Incident {
  id: string;
  createdAt: Date;
  updatedAt: Date;

  title: string;
  description: string;
  severity: IncidentSeverity;
  status: IncidentStatus;

  triggerEvent: string;
  triggerEventId: string;
  correlationId: string;

  assignedAgent: string;
  tags: string[];

  context: {
    repository?: string;
    branch?: string;
    commit?: string;
    environment?: string;
    service?: string;
    [key: string]: any;
  };

  investigation?: {
    findings: string[];
    hypothesis?: string;
    confidence?: number;
  };

  actions: IncidentAction[];

  resolvedAt?: Date;
  resolution?: {
    action: string;
    success: boolean;
    details: string;
  };

  aiAnalysis?: {
    invokedAt: Date;
    prompt: string;
    response: string;
    modelUsed: string;
  };

  /** Internal flag: set by findOrCreateIncident to indicate an existing incident was reused. */
  _wasCorrelated?: boolean;
}

/** Window within which a duplicate incident is correlated instead of created fresh. */
const CORRELATION_WINDOW_HOURS = 2;

/** Path to the structured escalation audit log. */
const AUDIT_LOG_PATH = join(__dirname, '../../audit.log');

export interface FindOrCreateInput {
  title: string;
  description: string;
  severity: IncidentSeverity;
  triggerEvent: string;
  triggerEventId: string;
  correlationId: string;
  assignedAgent: string;
  tags: string[];
  context: Incident['context'];
}

export class IncidentStore {

  // ── Core CRUD ──────────────────────────────────────────────────────────────

  async createIncident(
    incident: Omit<Incident, 'id' | 'createdAt' | 'updatedAt' | 'actions'>,
  ): Promise<Incident> {
    const pool = getPool();
    const id = `INC-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const now = new Date();

    await pool.query(
      `INSERT INTO incidents (
        id, created_at, updated_at, title, description, severity, status,
        trigger_event, trigger_event_id, correlation_id, assigned_agent, tags, context
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        id, now, now,
        incident.title, incident.description, incident.severity, incident.status,
        incident.triggerEvent, incident.triggerEventId, incident.correlationId,
        incident.assignedAgent,
        JSON.stringify(incident.tags),
        JSON.stringify(incident.context),
      ],
    );

    return { id, createdAt: now, updatedAt: now, actions: [], ...incident };
  }

  /**
   * Correlation-aware creation.
   *
   * Before inserting a new incident, checks for an existing open incident
   * matching on correlationId OR (repository + branch + triggerEvent) within
   * the last CORRELATION_WINDOW_HOURS hours. If found, appends a
   * 'correlated_event' action and returns the existing incident with
   * _wasCorrelated = true. Otherwise creates a fresh incident.
   */
  async findOrCreateIncident(input: FindOrCreateInput): Promise<Incident & { _wasCorrelated: boolean }> {
    const pool = getPool();
    const windowStart = new Date(Date.now() - CORRELATION_WINDOW_HOURS * 3600 * 1000);

    // Match 1: same correlationId (e.g. same repo full_name) within window
    const byCorrelation = await pool.query<{ id: string }>(
      `SELECT id FROM incidents
       WHERE status != 'resolved'
         AND correlation_id = $1
         AND trigger_event = $2
         AND created_at > $3
       ORDER BY created_at DESC
       LIMIT 1`,
      [input.correlationId, input.triggerEvent, windowStart],
    );

    // Match 2: same repo + branch + triggerEvent within window
    const byContext = byCorrelation.rows.length === 0
      ? await pool.query<{ id: string }>(
          `SELECT id FROM incidents
           WHERE status != 'resolved'
             AND trigger_event = $1
             AND context->>'repository' = $2
             AND context->>'branch' = $3
             AND created_at > $4
           ORDER BY created_at DESC
           LIMIT 1`,
          [
            input.triggerEvent,
            input.context.repository ?? '',
            input.context.branch ?? '',
            windowStart,
          ],
        )
      : { rows: [] };

    const existingId = byCorrelation.rows[0]?.id ?? byContext.rows[0]?.id;

    if (existingId) {
      // Append a correlated-event action and refresh updated_at
      await pool.query(
        `INSERT INTO incident_actions
           (incident_id, timestamp, agent, action, tool, args, result, details)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          existingId, new Date(), input.assignedAgent,
          'correlated_event', 'incident-store', JSON.stringify({}),
          'success',
          `Correlated event: ${input.triggerEventId} (${input.triggerEvent}) appended to existing incident`,
        ],
      );
      await pool.query('UPDATE incidents SET updated_at = NOW() WHERE id = $1', [existingId]);

      const existing = await this.getIncident(existingId);
      if (!existing) throw new Error(`Correlation: could not reload incident ${existingId}`);
      return { ...existing, _wasCorrelated: true };
    }

    const created = await this.createIncident({ ...input, status: 'investigating' });
    return { ...created, _wasCorrelated: false };
  }

  async getIncident(id: string): Promise<Incident | null> {
    const pool = getPool();
    const result = await pool.query('SELECT * FROM incidents WHERE id = $1', [id]);
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    const actions = await this.getActions(id);
    return this.rowToIncident(row, actions);
  }

  async addAction(incidentId: string, action: IncidentAction): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO incident_actions
         (incident_id, timestamp, agent, action, tool, args, result, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        incidentId, action.timestamp, action.agent, action.action,
        action.tool, JSON.stringify(action.args ?? {}), action.result, action.details,
      ],
    );
    await pool.query('UPDATE incidents SET updated_at = NOW() WHERE id = $1', [incidentId]);
  }

  /**
   * Append a finding string to the incident's investigation.findings array.
   * Creates the investigation object if it doesn't exist yet.
   */
  async addFinding(incidentId: string, finding: string): Promise<void> {
    const pool = getPool();
    // Atomic JSON append: initialize array if null, then append.
    await pool.query(
      `UPDATE incidents
       SET investigation = jsonb_set(
         COALESCE(investigation, '{"findings":[]}'::jsonb),
         '{findings}',
         (COALESCE(investigation->'findings', '[]'::jsonb)) || to_jsonb($1::text)
       ),
       updated_at = NOW()
       WHERE id = $2`,
      [finding, incidentId],
    );
  }

  async updateStatus(incidentId: string, status: IncidentStatus): Promise<void> {
    const pool = getPool();
    await pool.query(
      'UPDATE incidents SET status = $1, updated_at = NOW() WHERE id = $2',
      [status, incidentId],
    );

    if (status === 'escalated') {
      await this.writeEscalationAuditLog(incidentId);
    }
  }

  async resolveIncident(incidentId: string, resolution: Incident['resolution']): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE incidents
       SET status = 'resolved', resolved_at = NOW(), resolution = $1, updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(resolution), incidentId],
    );
  }

  async getOpenIncidents(): Promise<Incident[]> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM incidents WHERE status != 'resolved' ORDER BY created_at DESC`,
    );
    const incidents: Incident[] = [];
    for (const row of result.rows) {
      const actions = await this.getActions(row.id);
      incidents.push(this.rowToIncident(row, actions));
    }
    return incidents;
  }

  // ── Escalation audit log ───────────────────────────────────────────────────

  /**
   * Writes a JSON line to audit.log when an incident is escalated.
   * Format: one JSON object per line, machine-readable.
   * Never throws — escalation must not fail because the log write failed.
   */
  private async writeEscalationAuditLog(incidentId: string): Promise<void> {
    try {
      const incident = await this.getIncident(incidentId);
      if (!incident) return;

      const entry = {
        ts: new Date().toISOString(),
        level: 'ESCALATION',
        incidentId: incident.id,
        title: incident.title,
        severity: incident.severity,
        triggerEvent: incident.triggerEvent,
        correlationId: incident.correlationId,
        repository: incident.context.repository,
        branch: incident.context.branch,
        findings: incident.investigation?.findings ?? [],
        actionCount: incident.actions.length,
      };

      await appendFile(AUDIT_LOG_PATH, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (err) {
      // Log to stderr but never propagate — the incident update already succeeded.
      console.error('[IncidentStore] Failed to write escalation audit log:', err instanceof Error ? err.message : String(err));
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async getActions(incidentId: string): Promise<IncidentAction[]> {
    const pool = getPool();
    const result = await pool.query(
      'SELECT * FROM incident_actions WHERE incident_id = $1 ORDER BY timestamp ASC',
      [incidentId],
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

  private rowToIncident(row: Record<string, any>, actions: IncidentAction[]): Incident {
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
}

export const incidentStore = new IncidentStore();
