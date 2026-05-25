// src/tools/index.ts
import { Tool, createTool } from "./toolFactory";
import { createRagQueryTool } from "./rag_query";
import { createRememberTool } from "./remember";
import { marketSnapshotTool } from "./market";
import { createSystemCheckTool } from "./system_check";
import { marketBriefTool } from "./market/brief";
import { watchlistTool } from "./market/watchlist";
import { portfolioTool } from "./market/portfolio";

// ── Registry ────────────────────────────────────
export const toolsRegistry: Record<string, Tool> = {
  system_check: createSystemCheckTool(),
  rag_query: createRagQueryTool(),
  remember: createRememberTool(),
  market_snapshot: marketSnapshotTool,
  market_brief: marketBriefTool,
  watchlist: watchlistTool,
  portfolio: portfolioTool,
};


// ── Re-exports for convenience ──────────────────
export { createSystemCheckTool };
export { marketSnapshotTool };
export { marketBriefTool };
export { watchlistTool };
export { portfolioTool };
