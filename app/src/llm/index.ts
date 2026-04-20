// src/llm/index.ts
import { ChatOllama } from "@langchain/ollama";

// ✅ Export the model instance (this is what nodes.ts needs)
export const model = new ChatOllama({
  model: process.env.OLLAMA_MODEL || "llama3.2:3b",
  temperature: 0,
  baseUrl: process.env.OLLAMA_HOST || "http://localhost:11434",
  format: "json", // Critical for structured tool-calling output
});

// ✅ Optional: Export a retry wrapper for robustness
export const invokeWithRetry = async (
  messages: any[], 
  retries = 3
) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await model.invoke(messages);
    } catch (error: any) {
      if (i === retries - 1) throw error;
      console.log(`[LLM] Retry ${i + 1}/${retries} after error:`, error.message);
      await new Promise(res => setTimeout(res, 1000 * (i + 1)));
    }
  }
};