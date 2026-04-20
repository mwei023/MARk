// src/llm/embeddings.ts
import { OllamaEmbeddings } from "@langchain/ollama";

export const embeddings = new OllamaEmbeddings({
  model: process.env.OLLAMA_EMBEDDING_MODEL || "llama3.2:3b",
  baseUrl: process.env.OLLAMA_HOST || "http://localhost:11434",
});