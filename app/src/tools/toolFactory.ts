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
 * Uses `any` args on the registry surface so Zod v4 inferred types
 * (unknown-based) stay assignable without per-tool casts.
 */
export type Tool = {
  name: string;
  description: string;
  argsSchema: z.ZodTypeAny;
  func: (args: any) => Promise<string>;
};