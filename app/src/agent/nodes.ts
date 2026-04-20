// src/agent/nodes.ts
import { AgentState, ToolCall } from "./state";
import { model } from "../llm";
import { toolsRegistry, Tool } from "../tools"; 
import { z } from "zod";

// Register tools here (expand as you add more)
const tools = toolsRegistry;

// Prompt template for structured tool calling
const TOOL_CALL_PROMPT = `
You are Jarvis, a helpful AI assistant for Mwei.

AVAILABLE TOOLS (call these when appropriate):
1. system_check
   - Use when: user asks about Docker, containers, system status
   - Examples: "are my containers running?", "show docker stats", "check system health"
   - Args: { action: "ps" | "stats" | "images" | "logs" | "version" }

2. rag_query  
   - Use when: user asks a question about their notes, past learnings, or saved info
   - Examples: "What did I learn about pgvector?", "What do I prefer about TypeScript?", "show me my notes on X"
   - Args: { query: "the search question" }

3. remember
   - Use when: user explicitly says "remember", "save this", "note that", or "don't forget"
   - Examples: 
     • "remember that I prefer TypeScript strict mode" → { note: "I prefer TypeScript strict mode", topic: "typescript" }
     • "save this: my name is Mwei" → { note: "my name is Mwei", topic: "personal" }
     • "note that pgvector uses HNSW indexing" → { note: "pgvector uses HNSW indexing", topic: "devops" }
   - Args: { note: "the fact to save (min 10 chars)", topic?: "optional category" }

RESPONSE FORMAT RULES (STRICT):
You MUST respond with EXACTLY ONE of these JSON objects (no extra text, no markdown):

{"tool_call": {"name": "system_check", "args": {"action": "ps"}}}
{"tool_call": {"name": "rag_query", "args": {"query": "What did I learn about X?"}}}
{"tool_call": {"name": "remember", "args": {"note": "fact to save", "topic": "optional"}}}
{"response": "your natural conversational answer when no tool is needed"}

ADDITIONAL RULES:
- If user says "remember"/"save"/"note", ALWAYS call the 'remember' tool
- After a tool returns "[Tool result: ...]", do NOT call tools again - just respond naturally
- If rag_query returns no results, say: "I don't have notes on that yet. Would you like me to remember something about it?"
- Never invent tools or args. If unsure, ask for clarification.

User message: {input}
`.trim();

export const llmNode = async (state: typeof AgentState.State) => {
  const { messages, userId } = state;
  const lastMessage = messages[messages.length - 1];

  if (lastMessage?.includes("[Tool result:")) {
  const toolMatch = lastMessage.match(/\[Tool result: (\w+)\]/);
  const toolName = toolMatch?.[1] || "tool";
  let summary = lastMessage.replace(/\[Tool result:.*?\]\n?/, '').trim();
  
  // Add emoji prefix ONCE here
  const emoji = toolName === "system_check" ? "✅" : 
                toolName === "remember" ? "✅" : 
                toolName === "rag_query" ? "📚" : "💡";
  
  return {
    next: "end",
    messages: [`Jarvis: ${emoji} ${summary}`],  // ← Single emoji prefix
  };
}
  
  const prompt = TOOL_CALL_PROMPT.replace("{input}", lastMessage);
  
  try {
    const response = await model.invoke([{ role: "user", content: prompt }]);
    const content = typeof response.content === 'string' 
      ? response.content 
      : JSON.stringify(response.content);
    
    // Parse the JSON response
    const parsed = JSON.parse(content);
    
    console.log("[llmNode] Parsed decision:", parsed.tool_call ? `CALL ${parsed.tool_call.name}` : "RESPOND");

    if (parsed.tool_call && tools[parsed.tool_call.name]) {
      // Validate args against Zod schema
      const tool = tools[parsed.tool_call.name];
      const validatedArgs = tool.argsSchema.parse(parsed.tool_call.args);
      
      return {
        next: "execute_tool",
        tool_call: { name: parsed.tool_call.name, args: validatedArgs },
      };
    }
    
    if (parsed.response) {
      return {
        next: "end",
        messages: [`Jarvis: ${parsed.response}`],
      };
    }
    
    // Fallback if parsing fails
    return {
      next: "end",
      messages: [`Jarvis: I received your request but couldn't process it. Please try rephrasing.`],
    };
    
  } catch (error) {
    console.error("[LLM Node Error]", error);
    return {
      next: "end",
      messages: [`Jarvis: ⚠️ Error processing request. Check logs for details.`],
    };
  }
};

export const toolExecutorNode = async (state: typeof AgentState.State) => {
  console.log("[toolExecutorNode] Executing tool:", state.tool_call?.name);
  const { tool_call, userId } = state;
  if (!tool_call) return { next: "end", tool_result: undefined };
  
  const tool = tools[tool_call.name as keyof typeof tools];
  if (!tool) {
    return { 
      next: "end", 
      tool_result: `❌ Unknown tool: ${tool_call.name}`,
      messages: [`Jarvis: I don't have a tool named "${tool_call.name}".`]
    };
  }
  
  try {
    const result = await tool.func(tool_call.args);
    return {
      next: "llm", // Loop back to LLM to formulate natural response
      tool_result: result,
      messages: [`[Tool result: ${tool_call.name}]\n${result}`],
    };
  } catch (error: any) {
    return {
      next: "end",
      tool_result: `Error: ${error.message}`,
      messages: [`Jarvis: ⚠️ ${error.message}`],
    };
  }
};