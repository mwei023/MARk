// src/api/server.ts
import express from 'express';
import { markRuntime } from '../core/mark-runtime';
import { runHealthChecks, logAlert } from '../monitoring/proactive';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env' });
const app = express();
app.use(express.json());

// 🔌 PostgreSQL pool (reuse your existing config)
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// 🧠 Ask endpoint
app.post('/api/ask', async (req, res) => {
  try {
    const { query, userId = 'mwei' } = req.body;
    if (!query) return res.status(400).json({ error: 'Query required' });
    const result = await markRuntime.executeCommand(query, userId, 'api');
    res.json({ success: true, response: result.response, route: result.route, timestamp: new Date().toISOString() });
  } catch (error: any) {
    console.error('[API /ask Error]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🚨 Alerts endpoint
app.get('/api/alerts', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, alert_type, severity, message, value, threshold, suggestion, resolved, created_at 
       FROM jarvis_alerts ORDER BY created_at DESC LIMIT 50`
    );
    res.json({ success: true, alerts: rows });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message, alerts: [] });
  }
});

// 💓 Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

const PORT = process.env.API_PORT || 3001;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Jarvis API listening on :${PORT}`));
