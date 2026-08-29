// src/tools/market/index.ts
import { z } from "zod";
import { createTool } from "../toolFactory";

// Tool: Get price + basic stats for a symbol
export const marketSnapshotTool = createTool({
  name: "market_snapshot",
  description: "Get current price, 24h change, and volume for a crypto symbol",
  argsSchema: z.object({
    symbol: z.string()
      .regex(/^[a-z0-9\-]+$/, "Use CoinGecko IDs: bitcoin, ethereum, solana")
      .describe("Coin ID (lowercase, e.g., 'bitcoin')"),
  }),
  func: async (args) => {
    try {
      const res = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${args.symbol}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`
      );
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data = await res.json();
      const coin = data[args.symbol];
      if (!coin?.usd) throw new Error(`Symbol '${args.symbol}' not found`);
      
      const price = coin.usd.toLocaleString();
      const change = coin.usd_24h_change?.toFixed(2) || "N/A";
      const marketCap = coin.market_cap
      ? `$${(coin.market_cap / 1e9).toFixed(2)}B`
      : "N/A";

      const trend = coin.usd_24h_change > 2 ? "📈" : coin.usd_24h_change < -2 ? "📉" : "➡️";
      
      return `📊 ${args.symbol.toUpperCase()}: $${price} | 24h: ${trend} ${change}% | Market Cap: ${marketCap}`;
    } catch (error: any) {
      return `❌ Market error: ${error.message}`;
    }
  },
});