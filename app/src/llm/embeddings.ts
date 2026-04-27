import { OllamaEmbeddings } from "@langchain/ollama";

const embeddingModel = process.env.OLLAMA_EMBEDDING_MODEL || "nomic-embed-text";
console.log(`🔍 Embeddings model: ${embeddingModel}`); // ← Add this line

export const embeddings = new OllamaEmbeddings({
  model: embeddingModel,
  baseUrl: process.env.OLLAMA_HOST || "http://localhost:11434",
});;