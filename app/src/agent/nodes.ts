// src/agent/nodes.ts
import { AgentState, ToolCall } from "./state";
import { model, getModel, SYSTEM_PROMPT } from "../llm"; // ✅ Import SYSTEM_PROMPT
import { toolsRegistry, Tool } from "../tools"; 
import { z } from "zod";

// Register tools here (expand as you add more)
const tools = toolsRegistry;

// Prompt template for structured tool calling
/*const SYSTEM_PROMPT = `
You are Jarvis, a private voice assistant with access to the user's personal knowledge base.

🔍 TOOL USAGE RULES:
1. ALWAYS call "rag_query" when the user asks about:
   - Their preferences ("what's my favorite X?")
   - Things they told you to remember ("what did I say about Y?")
   - Their notes, learnings, or past conversations
   - Questions starting with: "what's my...", "did I mention...", "remind me about..."

2. ONLY respond directly when:
   - The question is general knowledge ("what is Docker?")
   - The user asks for system actions ("check CPU usage")
   - rag_query returns no results (then say: "I don't have notes on that yet")

3. If unsure, CALL rag_query first — it's better to check than to guess.

🗣️ RESPONSE STYLE:
- Keep answers concise, friendly, and conversational
- When quoting saved notes, paraphrase naturally: "You mentioned that your favorite color is blue"
- Never mention tool names or technical details to the user

📝 EXAMPLE FLOW:
User: "what's my favorite color?"
→ You: [CALL rag_query with query="favorite color"]
→ Tool returns: "My favourite color is blue"
→ You: "Your favorite color is blue."
`;*/

export const llmNode = async (state: typeof AgentState.State) => {
  const { messages, userId, history } = state;
  const lastMessage = messages[messages.length - 1];

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
  
  const prompt = TOOL_CALL_PROMPT
    .replace("{input}", lastMessage)
    .replace("{history}", history || "No history yet.");
    
  try {
    // ✅ Pass system prompt + user prompt as message array
    const response = await getModel().invoke([
      { role: "system", content: SYSTEM_PROMPT }, // ✅ System prompt here
      { role: "user", content: prompt }            // ✅ User prompt here
    ]);
    
    const content = typeof response.content === 'string' 
      ? response.content 
      : JSON.stringify(response.content);
    
    const parsed = JSON.parse(content);
    
    console.log("[llmNode] Parsed decision:", parsed.tool_call ? `CALL ${parsed.tool_call.name}` : "RESPOND");

    if (parsed.tool_call && tools[parsed.tool_call.name]) {
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

const toolDefinitions = Object.entries(tools).map(([name, tool]) => {
  return `- ${name}: ${tool.description}\n  Args: ${JSON.stringify(tool.argsSchema.shape, null, 2)}`;
}).join('\n\n');

export const TOOL_CALL_PROMPT = `
${SYSTEM_PROMPT}

🛠️ AVAILABLE TOOLS:
${toolDefinitions}

📋 OUTPUT FORMAT (STRICT JSON):
You MUST respond with ONE of these JSON structures:

Option 1 - Call a tool:
{
  "tool_call": {
    "name": "tool_name_here",
    "args": { /* validated args matching the tool's schema */ }
  }
}

Option 2 - Respond directly:
{
  "response": "Your natural language answer here"
}

❗ RULES:
- Output ONLY valid JSON. No markdown, no explanations, no extra text.
- If calling a tool, ensure args match the schema exactly.
- If the user asks about personal knowledge, PREFER rag_query.

📥 CURRENT CONTEXT:
User's recent history: {history}

🗣️ USER INPUT:
{input}

👉 Your JSON response:
`;