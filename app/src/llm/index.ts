// src/llm/index.ts - lazy initialization
import { ChatOllama } from "@langchain/ollama";


// ✅ Export system prompt for use in nodes.ts
export const SYSTEM_PROMPT = `
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
`;

let _model: ChatOllama | null = null;

export const getModel = (): ChatOllama => {
  if (!_model) {
    const host = process.env.OLLAMA_HOST || "http://localhost:11434";
    const modelName = process.env.OLLAMA_MODEL || "llama3.2:3b";
    
    console.log(`[LLM] Initializing model: ${modelName} @ ${host}`);
    
    // ✅ NO .bind() - system prompt is passed in message array at invocation
    _model = new ChatOllama({
      model: modelName,
      temperature: 0,
      baseUrl: host,
      format: "json",
    });
  }
  return _model;
};

// Keep for backwards compatibility
export const model = new Proxy({} as ChatOllama, {
  get: (_, prop) => {
    return (getModel() as any)[prop];
  }
});