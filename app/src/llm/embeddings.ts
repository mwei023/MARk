/**
 * Embeddings provider for RAG system
 * 
 * Currently uses Ollama for local embeddings.
 * Embeddings are distinct from chat LLM and remain local for privacy.
 */

import { OllamaEmbeddings } from "@langchain/ollama";

const embeddingModel = process.env.OLLAMA_EMBEDDING_MODEL || "nomic-embed-text";
const embeddingHost = process.env.OLLAMA_HOST || "http://localhost:11434";

console.log(`[Embeddings] Model: ${embeddingModel} @ ${embeddingHost}`);

export const embeddings = new OllamaEmbeddings({
  model: embeddingModel,
  baseUrl: embeddingHost,
});