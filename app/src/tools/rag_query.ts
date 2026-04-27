// src/tools/rag_query.ts
import { z } from "zod";
import { createTool } from "./index";
import { retrieveContext } from "../rags";

export const ragQueryArgsSchema = z.object({
  query: z.string().min(5).max(500).describe("The question or topic to search for"),
  limit: z.number().min(1).max(10).default(3).describe("Max results to return"),
});

export const createRagQueryTool = () => createTool({
  name: "rag_query",
  description: "Search your personal knowledge base. Use for: 'what did I learn about X?', 'show me notes on Y'",
  argsSchema: ragQueryArgsSchema,
  func: async (args) => {
  try {
    // Simple topic extraction: look for [topic] in query or infer from keywords
    let topic: string | undefined;
    const lowerQuery = args.query.toLowerCase();
    if (lowerQuery.includes('typescript')) topic = 'typescript';
    else if (lowerQuery.includes('song') || lowerQuery.includes('music')) topic = 'personal';
    else if (lowerQuery.includes('docker') || lowerQuery.includes('container')) topic = 'devops';
    
    const results = await retrieveContext(
  args.query,      // query
  args.limit,      // limit (number)
  topic,           // topic (string | undefined)
  0.3              // threshold (lower for personal notes)
);
    
    if (!results || results.trim() === "") {
      return `🔍 No notes found for "${args.query}". Try rephrasing or add more docs.`;
    }
    
    return `Found results for "${args.query}":\n\n${results}`;
  } catch (error: any) {
    console.error("[rag_query error]", error);
    return `⚠️ Error searching knowledge base: ${error.message}`;
  }
},
});