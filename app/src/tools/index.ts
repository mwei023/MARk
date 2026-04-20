// src/tools/index.ts
import { z } from "zod";
import { createRagQueryTool } from "./rag_query";
import { createRememberTool } from "./remember";

// ── Types ───────────────────────────────────────
export interface Tool<TArgs extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  argsSchema: TArgs;
  func: (args: z.infer<TArgs>) => Promise<string>;
}

// ── Factory ─────────────────────────────────────
export const createTool = <TArgs extends z.ZodTypeAny>(config: {
  name: string;
  description: string;
  argsSchema: TArgs;
  func: (args: z.infer<TArgs>) => Promise<string>;
}): Tool<TArgs> => ({
  name: config.name,
  description: config.description,
  argsSchema: config.argsSchema,
  func: config.func,
});

// ── Import Tools ────────────────────────────────
import { createSystemCheckTool } from "./system_check";

// ── Registry ────────────────────────────────────
export const toolsRegistry: Record<string, Tool> = {
  system_check: createSystemCheckTool(),
  rag_query: createRagQueryTool(),
  remember: createRememberTool(),
};

// ── Re-exports for convenience ──────────────────
export { createSystemCheckTool };

