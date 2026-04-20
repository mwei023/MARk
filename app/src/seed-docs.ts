// src/seed-docs.ts
// ── LOAD ENV FIRST, BEFORE ANYTHING ELSE ──────────────────
import * as dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from project root (jarvis-core/)
const envPath = resolve(__dirname, '../../.env');
console.log('🔍 Loading .env from:', envPath);

const envResult = dotenv.config({ path: envPath });
if (envResult.error) {
  console.warn('⚠️ .env load warning:', envResult.error.message);
}

// Debug: Show what loaded (password hidden)
console.log('🔍 Env check:');
console.log('  DATABASE_URL:', process.env.DATABASE_URL?.replace(/:[^:@]+@/, ':***@') || '❌ NOT SET');
console.log('  DB_PASSWORD:', process.env.DB_PASSWORD ? '***set***' : '❌ missing');

// ── NOW IMPORT YOUR APP CODE (after dotenv) ───────────────
import { ingestDocument } from '../rags';

// ── SEED FUNCTION ─────────────────────────────────────────
const seed = async () => {
  console.log('\n🌱 Seeding knowledge base...\n');
  
  try {
    // Document 1: pgvector
    await ingestDocument(
      "pgvector is a PostgreSQL extension that enables vector similarity search. Key features: HNSW indexing for fast approximate nearest neighbor search, cosine distance metric, supports 1024-dim embeddings for llama3 models.",
      { topic: "pgvector", source: "research_notes", date: "2026-04-17" }
    );
    
    // Document 2: LangGraph
    await ingestDocument(
      "LangGraph is a framework for building stateful, multi-agent applications with LangChain. It uses nodes and edges to define workflows, supports loops and conditional routing, and is ideal for building agentic systems like Jarvis.",
      { topic: "langgraph", source: "research_notes", date: "2026-04-17" }
    );
    
    console.log('\n✅ Seeded 2 documents. Ready for RAG queries.');
    
  } catch (error: any) {
    console.error('\n❌ Seed failed:', error.message);
    console.log('\n💡 Troubleshooting:');
    console.log('  1. Is PostgreSQL running? → docker compose ps');
    console.log('  2. Does the documents table exist? → See fix below');
    console.log('  3. Is pgvector extension installed? → SELECT * FROM pg_extension WHERE extname = \'vector\';');
    process.exit(1);
  }
};

// ── RUN ───────────────────────────────────────────────────
seed().catch(console.error);