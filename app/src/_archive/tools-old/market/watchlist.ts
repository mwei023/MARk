// src/tools/market/watchlist.ts
import { z } from "zod";
import { createTool } from "../toolFactory";
import { pool } from "../../db/postgres"; // your PG pool

export const watchlistTool = createTool({
  name: "watchlist",
  description: "Manage price alerts for symbols. Actions: add, remove, list, check",
  argsSchema: z.object({
    action: z.enum(['add', 'remove', 'list', 'check']),
    symbol: z.string().optional().describe("CoinGecko ID"),
    condition: z.object({
      type: z.enum(['above', 'below']),
      price: z.number(),
    }).optional(),
  }),
  func: async (args) => {
    const userId = "mwei"; // TODO: pass from context
    
    if (args.action === 'add' && args.symbol && args.condition) {
      await pool.query(
        `INSERT INTO jarvis_watchlist (user_id, symbol, alert_type, threshold, created_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (user_id, symbol, alert_type) 
         DO UPDATE SET threshold = EXCLUDED.threshold`,
        [userId, args.symbol, args.condition.type, args.condition.price]
      );
      return `✅ Alert set: Notify when ${args.symbol.toUpperCase()} goes ${args.condition.type} $${args.condition.price}`;
    }
    
    if (args.action === 'list') {
      const res = await pool.query(
        `SELECT symbol, alert_type, threshold FROM jarvis_watchlist WHERE user_id = $1`,
        [userId]
      );
      if (res.rows.length === 0) return "📭 No watchlist alerts set.";
      return "🔔 Your alerts:\n" + res.rows.map(r => 
        `• ${r.symbol.toUpperCase()}: notify when ${r.alert_type} $${r.threshold}`
      ).join('\n');
    }
    
    if (args.action === 'check') {
      // Run immediate check against current prices
      const alerts = await pool.query(
        `SELECT symbol, alert_type, threshold FROM jarvis_watchlist WHERE user_id = $1`,
        [userId]
      );
      const triggered: string[] = [];
      
      for (const row of alerts.rows) {
        const res = await fetch(
          `https://api.coingecko.com/api/v3/simple/price?ids=${row.symbol}&vs_currencies=usd`
        );
        const data: any = await res.json();
        const current = data[row.symbol]?.usd;
        
        if (current) {
          const hit = (row.alert_type === 'above' && current >= row.threshold) ||
                     (row.alert_type === 'below' && current <= row.threshold);
          if (hit) triggered.push(`${row.symbol.toUpperCase()} at $${current} (alert: ${row.alert_type} $${row.threshold})`);
        }
      }
      
      return triggered.length > 0 
        ? `🚨 Triggered:\n${triggered.join('\n')}` 
        : "✅ No alerts triggered.";
    }
    
    return "❌ Unknown watchlist action.";
  },
});