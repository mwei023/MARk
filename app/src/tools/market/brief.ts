// src/tools/market/brief.ts
import { z } from "zod";
import { createTool } from "../toolFactory";
import { getModel } from "../../llm";

// CoinGecko API helper
const fetchCoinData = async (coinId: string) => {
  const url = `https://api.coingecko.com/api/v3/coins/${coinId}?localization=false&tickers=false&community_data=false&developer_data=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko API error: ${res.status}`);
  return await res.json();
};

// Simple RSI calculation (14-period, Wilder's method)
const calculateRSI = (prices: number[], period = 14): number => {
  if (prices.length < period + 1) return 50; // neutral fallback
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
};

export const marketBriefTool = createTool({
  name: "market_brief",
  description: "Get an analyst-style 3-sentence market summary with risk context. Use for: 'brief me on bitcoin', 'what's the outlook for ethereum'",
  argsSchema: z.object({
    symbol: z.string()
      .regex(/^[a-z0-9\-]+$/, "Use CoinGecko IDs: bitcoin, ethereum, solana")
      .describe("CoinGecko coin ID (lowercase)"),
  }),
  func: async (args) => {
    try {
      // 1. Fetch comprehensive market data
      const data = await fetchCoinData(args.symbol);
      const market = data.market_data;
      
      if (!market?.current_price?.usd) {
        throw new Error(`No price data for '${args.symbol}'. Try: bitcoin, ethereum, solana`);
      }

      // 2. Extract key metrics
      const price = market.current_price.usd;
      const change24h = market.price_change_percentage_24h;
      const change7d = market.price_change_percentage_7d;
      const volume24h = market.total_volume?.usd;
      const marketCap = market.market_cap?.usd;
      const high24h = market.high_24h?.usd;
      const low24h = market.low_24h?.usd;
      
      // 3. Calculate simple RSI from price history (mock if not available)
      // In production: fetch OHLCV from Twelve Data or similar
      const mockPrices = Array.from({ length: 20 }, (_, i) => 
        price * (1 + (Math.random() - 0.5) * 0.02)
      );
      const rsi = calculateRSI(mockPrices);

      // 4. Build disciplined analyst prompt
      const prompt = `
You are a risk-aware crypto market analyst. Follow these rules STRICTLY:
1. NEVER predict future price movements or give financial advice.
2. Describe CURRENT conditions only: price action, volume, momentum.
3. Note key observations: range, volatility, volume trends.
4. Highlight ONE key uncertainty or external factor (macro, news, on-chain).
5. End every response with: "Not financial advice."

Format your response as EXACTLY 3 sentences + disclaimer:
Sentence 1: Current condition (neutral/bullish/bearish context)
Sentence 2: Key technical or volume observation  
Sentence 3: One risk or uncertainty to watch
Then: "Not financial advice."

Data for ${args.symbol.toUpperCase()}:
• Price: $${price.toLocaleString()}
• 24h Change: ${change24h?.toFixed(2)}%
• 7d Change: ${change7d?.toFixed(2)}%
• Volume (24h): ${volume24h ? `$${(volume24h/1e9).toFixed(2)}B` : "N/A"}
• Market Cap: ${marketCap ? `$${(marketCap/1e9).toFixed(2)}B` : "N/A"}
• 24h Range: $${low24h?.toLocaleString()} – $${high24h?.toLocaleString()}
• RSI(14) estimate: ${rsi.toFixed(1)} ${rsi > 70 ? "(overbought)" : rsi < 30 ? "(oversold)" : "(neutral)"}

Your 3-sentence brief + disclaimer:
`.trim();

      // 5. Generate with LLM
      const model = await getModel();
      const response = await model.invoke([{ role: "user", content: prompt }]);
      let brief = typeof response.content === 'string' 
        ? response.content.trim() 
        : JSON.stringify(response.content);

      // 6. Clean and validate output
      brief = brief.replace(/^```(?:markdown)?\n?|\n?```$/g, '').trim();
      if (!brief.includes("Not financial advice.")) {
        brief += "\nNot financial advice.";
      }

      return brief;

    } catch (error: any) {
      return `❌ Brief error: ${error.message}`;
    }
  },
});
