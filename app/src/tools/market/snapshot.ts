// app/src/tools/market/snapshot.ts
import { z } from "zod";
// ✅ Import from toolFactory, NOT from ../index (breaks the cycle)
import { createTool } from "../toolFactory";

export const marketSnapshotTool = createTool({
  name: "market_snapshot",
  description: "Get current price and 24h change for a crypto symbol (via CoinGecko)",
  argsSchema: z.object({
    symbol: z.string()
      .regex(/^[A-Za-z0-9\-]+$/, "Invalid symbol format")
      .describe("Crypto ID (e.g., 'bitcoin', 'ethereum', 'solana')"),
  }),
  func: async (args) => {
    try {
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${args.symbol.toLowerCase()}&vs_currencies=usd&include_24hr_change=true`;
      const res = await fetch(url);
      
      if (!res.ok) {
        throw new Error(`API returned ${res.status}: ${await res.text()}`);
      }
      
      const data = await res.json();
      const coin = data[args.symbol.toLowerCase()];
      
      if (!coin?.usd) {
        throw new Error(`Symbol '${args.symbol}' not found. Try: bitcoin, ethereum, solana`);
      }

      const price = coin.usd.toLocaleString();
      const change = coin.usd_24h_change?.toFixed(2) || "N/A";
      const trend = coin.usd_24h_change > 0 ? "📈" : coin.usd_24h_change < 0 ? "📉" : "➡️";
      
      return `📊 ${args.symbol.toUpperCase()}: $${price} | 24h: ${trend} ${change}%`;
      
    } catch (error: any) {
      return `❌ Market data error: ${error.message}`;
    }
  },
});