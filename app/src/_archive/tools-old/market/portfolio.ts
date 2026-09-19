// src/tools/market/portfolio.ts
import { z } from "zod";
import { createTool } from "../toolFactory";

export const portfolioTool = createTool({
  name: "portfolio",
  description: "Track your crypto holdings and P&L. Actions: add, remove, view, pnl",
  argsSchema: z.object({
    action: z.enum(['add', 'remove', 'view', 'pnl']),
    symbol: z.string().optional(),
    amount: z.number().optional(),
    buyPrice: z.number().optional(),
  }),
  func: async (args) => {
    // TODO: Wire to your PostgreSQL holdings table
    // For now, return a scaffold response
    if (args.action === 'view') {
      return `📊 Your portfolio (scaffold):
• BTC: 0.5 @ $65,000 avg → Current: $77,091 | P&L: +$6,045 (+9.3%)
• ETH: 2.0 @ $3,000 avg → Current: $3,180 | P&L: +$360 (+6.0%)
Total P&L: +$6,405 (+8.1%)`;
    }
    return `✅ Portfolio action '${args.action}' received. (Wire to DB next)`;
  },
});