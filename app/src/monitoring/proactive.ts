// src/monitoring/proactive.ts
import { exec } from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);

// 🎯 Configurable thresholds
export const THRESHOLDS = {
  diskUsage: 90,
  memoryUsage: 85,
  cpuLoad: 80,
  cloudflaredDown: true,
};

export type Alert = {
  type: 'disk' | 'memory' | 'cpu' | 'service' | 'cloudflared';
  severity: 'warning' | 'critical';
  message: string;
  suggestion?: string;
  value?: number;
  threshold?: number;
};

// 🩺 Health check functions
export const checkDisk = async (): Promise<Alert | null> => {
  try {
    const { stdout } = await execPromise('df / | tail -1');
    const parts = stdout.trim().split(/\s+/);
    const usage = parseInt(parts[4]);
    if (usage >= THRESHOLDS.diskUsage) {
      return {
        type: 'disk',
        severity: usage >= 95 ? 'critical' : 'warning',
        message: `Disk usage is at ${usage}%`,
        suggestion: 'Would you like me to find large files?',
        value: usage,
        threshold: THRESHOLDS.diskUsage,
      };
    }
  } catch (error) {
    console.error('[checkDisk] Error:', error);
  }
  return null;
};

export const checkMemory = async (): Promise<Alert | null> => {
  try {
    const { stdout } = await execPromise('free | grep Mem');
    const parts = stdout.trim().split(/\s+/);
    const total = parseInt(parts[1]);
    const used = parseInt(parts[2]);
    const usage = Math.round((used / total) * 100);
    if (usage >= THRESHOLDS.memoryUsage) {
      return {
        type: 'memory',
        severity: usage >= 95 ? 'critical' : 'warning',
        message: `Memory usage is at ${usage}%`,
        suggestion: 'Would you like me to show top processes?',
        value: usage,
        threshold: THRESHOLDS.memoryUsage,
      };
    }
  } catch (error) {
    console.error('[checkMemory] Error:', error);
  }
  return null;
};

export const checkCPU = async (): Promise<Alert | null> => {
  try {
    const { stdout } = await execPromise('uptime');
    const loadMatch = stdout.match(/load average: ([\d.]+)/);
    if (!loadMatch) return null;
    const load = parseFloat(loadMatch[1]);
    const cores = (await execPromise('nproc')).stdout.trim();
    const usage = Math.round((load / parseInt(cores)) * 100);
    if (usage >= THRESHOLDS.cpuLoad) {
      return {
        type: 'cpu',
        severity: usage >= 95 ? 'critical' : 'warning',
        message: `CPU load is high: ${load} (≈${usage}% of ${cores} cores)`,
        suggestion: 'Would you like me to show running processes?',
        value: usage,
        threshold: THRESHOLDS.cpuLoad,
      };
    }
  } catch (error) {
    console.error('[checkCPU] Error:', error);
  }
  return null;
};

export const checkCloudflared = async (): Promise<Alert | null> => {
  if (!THRESHOLDS.cloudflaredDown) return null;
  try {
    const { stdout } = await execPromise('systemctl is-active cloudflared');
    if (stdout.trim() !== 'active') {
      return {
        type: 'cloudflared',
        severity: 'critical',
        message: 'Cloudflare tunnel is not running',
        suggestion: 'Would you like me to restart it?',
      };
    }
  } catch (error) {
    return null; // Service might not exist
  }
  return null;
};

export const runHealthChecks = async (): Promise<Alert | null> => {
  const checks = [checkDisk, checkMemory, checkCPU, checkCloudflared];
  let critical: Alert | null = null;
  let warning: Alert | null = null;
  for (const check of checks) {
    const result = await check();
    if (!result) continue;
    if (result.severity === 'critical') return result;
    if (!warning) warning = result;
  }
  return critical || warning;
};

// 📝 Log alert — graceful fallback if DB not available
export const logAlert = async (
  alert: Alert, 
  userId: string, 
  resolved: boolean = false
): Promise<void> => {
  try {
    // Try to import your DB pool — but don't crash if it fails
    const { pool } = await import('../db/postgres').catch(() => ({ pool: null }));
    
    if (pool) {
      await pool.query(
        `INSERT INTO jarvis_alerts 
         (user_id, alert_type, severity, message, value, threshold, suggestion, resolved, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
        [
          userId,
          alert.type,
          alert.severity,
          alert.message,
          alert.value || null,
          alert.threshold || null,
          alert.suggestion || null,
          resolved,
        ]
      );
      console.log(`[AUDIT] Alert logged to DB: ${alert.type} | ${alert.severity}`);
    } else {
      // Fallback: just console log
      console.log(`[AUDIT] Alert (no DB): ${alert.type} | ${alert.severity} | ${alert.message}`);
    }
  } catch (error) {
    // Final fallback: console log
    console.log(`[AUDIT] Alert: ${alert.type} | ${alert.severity} | ${alert.message}`);
  }
};

// ✅ Export CommandKey type for continuous-loop.ts
export type CommandKey = 'restart_cloudflared' | 'find_large_files' | 'show_top_processes';