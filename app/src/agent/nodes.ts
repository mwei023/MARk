// src/agent/nodes.ts
import { AgentState, ToolCall } from "./state";
import { getLLMProviderCached, SYSTEM_PROMPT, Message } from "../llm";
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

const parseModelText = (content: unknown): string => {
  if (typeof content === 'string') return content.trim();
  if (content && typeof content === 'object') return JSON.stringify(content).trim();
  return '';
};

const isSystemOperationRequest = (text: string): boolean => {
  const lower = (text || '').toLowerCase();
  if (!lower) return false;

  const systemMarkers = [
    'list files', 'show files', 'directory', 'folder', 'ls -',
    'disk', 'storage', 'df ', 'space', 'memory', 'ram', 'cpu',
    'process', 'uptime', 'whoami', 'pwd', 'date', 'check disk',
    'check memory', 'check cpu', 'system status', 'top ', 'ps ',
    'free -', 'du ', 'cat ', 'head ', 'tail ', 'grep ', 'find '
  ];

  return systemMarkers.some(marker => lower.includes(marker));
};

const isGeneralKnowledgeQuestion = (text: string): boolean => {
  const lower = (text || '').toLowerCase();
  if (!lower) return false;
  if (isSystemOperationRequest(lower)) return false;

  const knowledgePatterns = [
    /\b(who|what|where|when|why|how)\s+(is|was|are|does|do|can|would)\b/,
    /\b(who's|what's|what are|who are|why is|how does|how do)\b/,
    /\b(explain|define|describe|compare|summarize|tell me about)\b/,
    /\b(president|capital|country|city|company|language|history)\b/
  ];

  return knowledgePatterns.some(pattern => pattern.test(lower));
};

const directReasoningReply = async (input: string) => {
  const provider = await getLLMProviderCached();
  const messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Answer the user directly and do not call any tool. Keep it short, factual, and conversational. Never invent facts about the user's machine (OS, CPU, RAM, device) — if you do not know, say so and suggest they ask for 'system info'. User: ${input}` }
  ];
  const response = await provider.chat(messages);
  const directText = response.content || 'I can help with that directly.';
  return {
    next: 'end',
    messages: [`Jarvis: ${directText}`],
  };
};

const isLikelyMarketRequest = (text: string): boolean => {
  const lower = (text || '').toLowerCase();
  if (!lower) return false;

  const directKnowledgeMarkers = [
    'explain', 'what is', 'how does', 'why', 'compare', 'neural network',
    'machine learning', 'database', 'docker', 'git', 'linux', 'algorithm',
    'computer science', 'programming', 'how to'
  ];
  const marketMarkers = [
    'bitcoin', 'ethereum', 'crypto', 'stock', 'market', 'portfolio',
    'watchlist', 'price', 'outlook', 'analyst', 'ticker', 'coin', 'token'
  ];

  if (directKnowledgeMarkers.some(marker => lower.includes(marker))) {
    return false;
  }

  return marketMarkers.some(marker => lower.includes(marker));
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
const buildPrompt = (history: string, input: string) => {
  // Dynamically list available tools from registry
  const toolsList = Object.entries(tools).map(([name, tool]) => 
    `- ${name}: ${tool.description}`
  ).join('\n');

  return `You are Jarvis, an AI assistant for Mwei.
Current time: ${getCurrentTimeNairobi()}

TOOLS AVAILABLE:
${toolsList}

⚠️ CRITICAL ROUTING RULES (DECIDE BASED ON USER INPUT ONLY):

🚫 NEVER USE market_brief OR market_snapshot for general knowledge or conceptual questions.
Only use a market tool when the user explicitly asks about a market asset, price, outlook, or a coin/stock/watchlist/portfolio request.
If the request is about explaining a concept (for example: "Explain neural networks", "What is Docker?", "How does a database work?"), respond directly and do not call any tool.
The word "brief" alone is NOT a market request unless it is clearly about a coin, token, stock, or market outlook.

✅ ROUTE BY INPUT KEYWORD:

IF user asks for a market asset or price such as: "bitcoin", "ethereum", "crypto", "stock", "coin", "portfolio", "watchlist", "price", "outlook" → market_* tools only for those market requests.
IF user says "favorite" OR "remind me" OR "did I" OR "my notes" → rag_query (personal memory)
IF user says "remember" OR "note" OR "save that" → remember (save to memory)
IF user says "watchlist" OR "alert" OR "price drop" → watchlist
IF user says "portfolio" OR "holdings" OR "my coins" → portfolio
IF user says "disk" OR "files" OR "storage" OR "cpu" → system_check
OTHERWISE → respond directly as Jarvis

💡 EXAMPLES (EXACT USER INPUTS):

User: "what's bitcoin price"
→ {"tool_call": {"name": "market_snapshot", "args": {"symbol": "bitcoin"}}}

User: "give me a brief on bitcoin"
→ {"tool_call": {"name": "market_brief", "args": {"symbol": "bitcoin"}}}

User: "brief me on ethereum"
→ {"tool_call": {"name": "market_brief", "args": {"symbol": "ethereum"}}}

User: "Explain neural networks"
→ {"response": "A neural network is a machine learning model inspired by biological neurons..."}

User: "what's my favorite color"
→ {"tool_call": {"name": "rag_query", "args": {"query": "favorite color"}}}

User: "remember I like blue"
→ {"tool_call": {"name": "remember", "args": {"note": "I like blue"}}}

User: "list files"
→ {"tool_call": {"name": "system_check", "args": {"command": "ls -la ~"}}}

CURRENT INPUT TO ROUTE:
User: ${input}

Output ONLY valid JSON, no markdown:
{"tool_call": {"name": "...", "args": {...}}} OR {"response": "answer"}
`.trim();
};



export const llmNode = async (state: typeof AgentState.State) => {
  const { messages, userId, history, input: userInput } = state;
  
  // Use the original user input for routing, not accumulated messages
  const currentInput = userInput || messages[0]?.replace("User: ", "") || "";
  
  if (isGeneralKnowledgeQuestion(currentInput) && !isSystemOperationRequest(currentInput)) {
    console.warn("[llmNode] Blocked general-knowledge request before tool routing:", currentInput);
    return directReasoningReply(currentInput);
  }
  
  // Handle tool result responses - only if we had a tool call before
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
  
  // NOTE: no keyword quick-router here by design. An earlier version matched
  // phrases like "my pc" or "open vlc" with regexes and misrouted constantly
  // ("open vlc and play j.cole" -> uname -a). Routing is the LLM's job: it
  // sees tool descriptions + rules in the prompt and picks. Tools enforce
  // safety via allowlists, not phrase lists.

  const prompt = buildPrompt(history || "No history yet.", currentInput || "");
  let response: any;
  
  try {
    const provider = await getLLMProviderCached();
    const messages: Message[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt }
    ];
    response = await provider.chat(messages);
    
    // Handle response from provider
    const content = response.content.trim();
    
    // Clean markdown code fences if LLM adds them
    const cleanedContent = content.replace(/^```(?:json)?\n?|\n?```$/g, '').trim();
    
    // Parse JSON with fallback
    let parsed: any;
    try {
      parsed = JSON.parse(cleanedContent);
    } catch (parseErr) {
      console.warn("[llmNode] JSON parse failed, attempting fallback...");
      // Fallback: treat as direct response
      return {
        next: "end",
        messages: [`Jarvis: ${content}`],
      };
    }
    
    console.log("[llmNode] Parsed:", JSON.stringify(parsed).slice(0, 200));

    if (parsed?.tool_call?.name === 'system_check' && !isSystemOperationRequest(currentInput)) {
      console.warn('[llmNode] Blocked system_check for non-system request:', currentInput);
      return directReasoningReply(currentInput);
    }

    if (isGeneralKnowledgeQuestion(currentInput) && !isSystemOperationRequest(currentInput)) {
      console.warn("[llmNode] Blocked general-knowledge request before tool routing:", currentInput);
      return directReasoningReply(currentInput);
    }

    // Handle tool call
    if (parsed?.tool_call?.name && tools[parsed.tool_call.name]) {
      const toolName = parsed.tool_call.name;
      if (toolName.startsWith('market_') && !isLikelyMarketRequest(currentInput)) {
        console.warn('[llmNode] Blocked market tool for non-market request:', currentInput);
        return directReasoningReply(currentInput);
      }

      const tool = tools[toolName];
      try {
        const validatedArgs = tool.argsSchema?.parse 
          ? tool.argsSchema.parse(parsed.tool_call.args || {}) 
          : parsed.tool_call.args || {};
        
        return {
          next: "execute_tool",
          tool_call: { name: toolName, args: validatedArgs },
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
  // 🔍 Detailed error logging
  console.error("[LLM Node Error]", {
    name: error?.name || 'Unknown',
    message: error?.message || 'No message',
    stack: error?.stack?.split('\n')[0] || 'No stack',
    // Log what the LLM actually returned (if anything)
    llmContent: response?.content
      ? (typeof response.content === 'string'
          ? response.content.slice(0, 200)
          : JSON.stringify(response.content)?.slice(0, 200))
      : 'No response content',
  });
  
  return {
    next: "end",
    messages: [`Jarvis: ⚠️ ${error?.message || 'I hit a snag. Please try again.'}`],
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
  console.error('🔍 [llmNode] Full error debug:', {
    errorType: typeof error,
    errorMessage: error?.message,
    errorName: error?.name,
    errorStack: error?.stack?.split('\n')[0],
  });
  // ... rest of existing catch logic
}
};