// src/test-embedding-dim.ts
import { OllamaEmbeddings } from "@langchain/ollama";
import * as dotenv from "dotenv";
dotenv.config({ path: "./.env" });

const embeddings = new OllamaEmbeddings({
  model: process.env.OLLAMA_EMBEDDING_MODEL || "nomic-embed-text",
  baseUrl: process.env.OLLAMA_HOST || "http://localhost:11434",
});

const main = async () => {
  const vec = await embeddings.embedQuery("test");
  console.log(`✅ Embedding dimension: ${Array.isArray(vec) ? vec.length : 'unknown'}`);
  console.log(`✅ First 5 values: ${Array.isArray(vec) ? vec.slice(0,5) : vec}`);
};

main();