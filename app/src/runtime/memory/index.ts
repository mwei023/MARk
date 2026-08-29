// src/runtime/memory/index.ts
export class MemoryManager {
  async storeEpisodic(episode: Episode) { /* PostgreSQL */ }
  async storeSemantic(fact: Fact) { /* pgvector/Qdrant */ }
  async setWorking(key: string, value: any, ttl: number) { /* Redis (or in-memory fallback) */ }
  async retrieve(query: string, type: 'episodic' | 'semantic' | 'working') { /* ... */ }
}