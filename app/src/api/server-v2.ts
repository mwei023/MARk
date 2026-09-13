/**
 * Mark API Server v2.0
 * Event-driven architecture with autonomous agents.
 * 
 * Routes:
 * POST /webhooks/github  - GitHub events
 * GET  /api/incidents    - List open incidents
 * GET  /api/incidents/:id - Get incident details
 * POST /api/approve      - User approves action
 * GET  /api/health       - Health check
 */

import express from 'express';
import * as dotenv from 'dotenv';
import { incidentStore } from '../core/incident';
import { agentRuntime } from '../core/agent-runtime';
import { GitHubWebhookHandler } from '../webhooks/github';
import { eventBus } from '../core/event-bus';
import { markRuntime } from '../core/mark-runtime';

dotenv.config({ path: '.env' });

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────────────────────
// Webhook Receivers
// ─────────────────────────────────────────────────────────────
const githubHandler = new GitHubWebhookHandler(eventBus);
app.post('/webhooks/github', githubHandler.handler());

// ─────────────────────────────────────────────────────────────
// API Endpoints
// ─────────────────────────────────────────────────────────────

/**
 * GET /api/incidents - List all open incidents
 */
app.get('/api/incidents', async (req, res) => {
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
 * GET /api/incidents/:id - Get incident details
 */
app.get('/api/incidents/:id', async (req, res) => {
  try {
    const incident = await incidentStore.getIncident(req.params.id);
    if (!incident) {
      return res.status(404).json({
        success: false,
        error: 'Incident not found',
      });
    }
    res.json({
      success: true,
      incident,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/approve - Grant approval for an action
 */
app.post('/api/approve', async (req, res) => {
  try {
    const { incidentId, approved } = req.body;
    
    if (!incidentId) {
      return res.status(400).json({
        success: false,
        error: 'incidentId required',
      });
    }

    if (approved) {
      await agentRuntime.grantApproval(incidentId);
    } else {
      await agentRuntime.denyApproval(incidentId);
    }

    res.json({
      success: true,
      message: `Approval ${approved ? 'granted' : 'denied'} for incident ${incidentId}`,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/command - Emit a user command
 */
app.post('/api/command', async (req, res) => {
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
 * GET /api/health - Health check
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/status - System status
 */
app.get('/api/status', async (req, res) => {
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
