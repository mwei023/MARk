// src/tools/remember.ts
import { z } from "zod";
import { createTool } from "./index";
import { ingestDocument } from "../rags";
import { logAction } from "../security";

export const rememberArgsSchema = z.object({
  note: z.string()
    .min(10, "Note must be at least 10 characters")
    .max(2000, "Note must be under 2000 characters")
    .describe("The fact, insight, or note you want to remember"),
  topic: z.string()
    .optional()
    .describe("Optional category/tag (e.g., 'typescript', 'devops', 'personal')"),
});

export const createRememberTool = () => createTool({
  name: "remember",
  description: "Save a note to your personal knowledge base. Use for: 'remember that pgvector uses HNSW indexing', 'save this idea for later'",
  argsSchema: rememberArgsSchema,
  func: async (args) => {
    try {
      // Ingest into your RAG knowledge base
      await ingestDocument(args.note, {
        topic: args.topic || "general",
        source: "jarvis_remember_command",
        saved_at: new Date().toISOString(),
        confidence: "user_explicit", // High-confidence user-saved note
      });
      
      // Log the action for audit trail
      await logAction(
        "jarvis", 
        `remember: ${args.note.slice(0, 50)}...`, 
        "SUCCESS",
        args.topic ? `topic:${args.topic}` : undefined
      );
      
      return `✅ Remembered: "${args.note}"${args.topic ? ` [${args.topic}]` : ''}`;

      return `Found results for "${args.query}":\n\n${results}`;
      
    } catch (error: any) {
      await logAction("jarvis", `remember: ${args.note}`, "ERROR", error.message);
      return `⚠️ Failed to save note: ${error.message}`;
    }
  },
});