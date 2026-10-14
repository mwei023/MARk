-- Migration 008: code-aware vector store for retrieval
-- documents.embedding is vector(1024) but nomic-embed-text emits 768 dims,
-- so code chunks get their own table rather than corrupting the RAG store.

CREATE TABLE IF NOT EXISTS code_chunks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  repo TEXT NOT NULL,
  file TEXT NOT NULL,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  symbol TEXT DEFAULT '',
  text TEXT NOT NULL,
  embedding vector(768),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_code_chunks_embedding
  ON code_chunks USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_code_chunks_repo
  ON code_chunks (repo);
