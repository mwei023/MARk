// src/agent/nodes.ts
import { AgentState, ToolCall } from "./state";
import { model, getModel, SYSTEM_PROMPT } from "../llm";
import { toolsRegistry, Tool } from "../tools"; 

const tools = toolsRegistry;

// 🕐 Helper: Get current time in Nairobi (your idea!)
const getCurrentTimeNairobi = () => {
  return new Date().toLocaleString('en-KE', {
    timeZone: 'Africa/Nairobi',
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

// Build tool definitions for the prompt
const toolDefinitions = Object.entries(tools).map(([name, tool]) => {
  const argsExample = Object.keys(tool.argsSchema?.shape || {}).length > 0
    ? JSON.stringify(Object.fromEntries(
        Object.entries(tool.argsSchema.shape).map(([k]) => [k, "value"])
      ), null, 2)
    : "{}";
  return `- ${name}: ${tool.description}\n  Args example: ${argsExample}`;
}).join('\n\n');

// Prompt template with time injection
const buildPrompt = (history: string, input: string) => `
You are Jarvis, an AI assistant for Mwei.
Current time: ${getCurrentTimeNairobi()}

TOOLS AVAILABLE:
- remember: save a personal fact. Args: {"note": "text"}
- rag_query: search Mwei's personal notes. Args: {"query": "text"}
- system_check: run safe shell commands. Args: {"command": "ls -la ~"}

DECISION RULES:
💡 EXAMPLES:
User: "What time is it?"
→ {"response": "It's ${getCurrentTimeNairobi()}."}

User: "list files" OR "show my files" OR "ls"
→ {"tool_call": {"name": "system_check", "args": {"command": "ls -la ~"}}}

User: "check disk space" OR "how much storage"
→ {"tool_call": {"name": "system_check", "args": {"command": "df -h"}}}

User: "what's my favorite color"
→ {"tool_call": {"name": "rag_query", "args": {"query": "favorite color"}}}

User: "remember I like blue"
→ {"tool_call": {"name": "remember", "args": {"note": "I like blue"}}}
- everything else → respond directly

Respond with ONE JSON only, no markdown:
{"response": "answer"} OR {"tool_call": {"name": "...", "args": {...}}}

History: ${history || "none"}
User: ${input}
`.trim();

export const llmNode = async (state: typeof AgentState.State) => {
  const { messages, userId, history } = state;
  const lastMessage = messages[messages.length - 1];
  

  // Handle tool result responses
  if (lastMessage?.includes("[Tool result:")) {
    const toolMatch = lastMessage.match(/\[Tool result: (\w+)\]/);
    const toolName = toolMatch?.[1] || "tool";
    let summary = lastMessage.replace(/\[Tool result:.*?\]\n?/, '').trim();
    
    const emoji = toolName === "system_check" ? "✅" : 
                  toolName === "remember" ? "✅" : 
                  toolName === "rag_query" ? "📚" : "💡";
    
    return {
      next: "end",
      messages: [`Jarvis: ${emoji} ${summary}`],
    };
  }
  
  // Quick pre-router for common commands (before LLM)
  const quickRoute = (text: string) => {
    const lower = (text || "").toLowerCase();
    if (/(list files|ls |show files|directory)/.test(lower)) 
      return { tool_call: { name: "system_check", args: { command: "ls -la ~" } } };
    if (/(disk|storage|df)/.test(lower)) 
      return { tool_call: { name: "system_check", args: { command: "df -h" } } };
    return null;
  };

  const routed = quickRoute(lastMessage);
  if (routed) {
    console.log("[llmNode] Quick-routed:", routed.tool_call.name);
    return { next: "execute_tool", tool_call: routed.tool_call };
  }

  const prompt = buildPrompt(history || "No history yet.", lastMessage || "");
    
  try {
    const response = await getModel().invoke([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt }
    ]);
    
    // Handle different response formats defensively
    let content = "";
    if (typeof response.content === 'string') {
      content = response.content.trim();
    } else if (response.content && typeof response.content === 'object') {
      content = JSON.stringify(response.content);
    }
    
    // Clean markdown code fences if LLM adds them
    content = content.replace(/^```(?:json)?\n?|\n?```$/g, '').trim();
    
    // Parse JSON with fallback
    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch (parseErr) {
      console.warn("[llmNode] JSON parse failed, attempting fallback...");
      // Fallback: treat as direct response
      return {
        next: "end",
        messages: [`Jarvis: ${content}`],
      };
    }
    
    console.log("[llmNode] Parsed:", JSON.stringify(parsed).slice(0, 200));

    // Handle tool call
    if (parsed?.tool_call?.name && tools[parsed.tool_call.name]) {
      const tool = tools[parsed.tool_call.name];
      try {
        const validatedArgs = tool.argsSchema?.parse 
          ? tool.argsSchema.parse(parsed.tool_call.args || {}) 
          : parsed.tool_call.args || {};
        
        return {
          next: "execute_tool",
          tool_call: { name: parsed.tool_call.name, args: validatedArgs },
        };
      } catch (schemaErr: any) {
        console.warn("[llmNode] Args validation failed, falling back to response:", schemaErr.message);
        return {
          next: "end",
          messages: [`Jarvis: I need a bit more detail to do that. Could you rephrase?`],
        };
      }
    }
    
    // Handle direct response
    if (parsed?.response) {
      return {
        next: "end",
        messages: [`Jarvis: ${parsed.response}`],
      };
    }
    
    // Fallback if structure is unexpected
    return {
      next: "end",
      messages: [`Jarvis: I received your request. How can I help further?`],
    };
    
  } catch (error: any) {
    console.error("[LLM Node Error]", error?.message || error);
    return {
      next: "end",
      messages: [`Jarvis: ⚠️ I hit a snag. Please try again in a moment.`],
    };
  }
};

export const toolExecutorNode = async (state: typeof AgentState.State) => {
  console.log("[toolExecutorNode] Executing:", state.tool_call?.name);
  const { tool_call, userId } = state;
  
  if (!tool_call?.name) {
    return { next: "end", tool_result: undefined };
  }
  
  const tool = tools[tool_call.name as keyof typeof tools];
  if (!tool) {
    return { 
      next: "end", 
      tool_result: `❌ Unknown tool: ${tool_call.name}`,
      messages: [`Jarvis: I don't have a tool named "${tool_call.name}".`]
    };
  }
  
  try {
    const result = await tool.func(tool_call.args || {});
    return {
      next: "llm",
      tool_result: result,
      messages: [`[Tool result: ${tool_call.name}]\n${result}`],
    };
  } catch (error: any) {
    console.error("[toolExecutorNode] Error:", error?.message);
    return {
      next: "end",
      tool_result: `Error: ${error.message}`,
      messages: [`Jarvis: ⚠️ ${error.message || "Something went wrong."}`],
    };
  }
};