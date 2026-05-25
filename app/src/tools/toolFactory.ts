// app/src/tools/toolFactory.ts
import { z } from "zod";

/**
 * Helper to create a typed tool definition.
 * Exported separately to avoid circular dependencies with tools/index.ts
 */
export const createTool = <T extends z.ZodTypeAny>(config: {
  name: string;
  description: string;
  argsSchema: T;
  func: (args: z.infer<T>) => Promise<string>;
}) => config;

/**
 * Type for a registered tool.
 */
export type Tool<T extends z.ZodTypeAny = z.ZodTypeAny> = ReturnType<typeof createTool<T>>;