// src/runtime/memory/index.ts
export interface Episode {
  id?: string;
  content: string;
  at?: string;
}

export interface Fact {
  key: string;
  value: unknown;
}

export class MemoryManager {
  async storeEpisodic(_episode: Episode): Promise<void> { /* PostgreSQL */ }
  async storeSemantic(_fact: Fact): Promise<void> { /* pgvector/Qdrant */ }
  async setWorking(_key: string, _value: any, _ttl: number): Promise<void> { /* Redis (or in-memory fallback) */ }
  async retrieve(_query: string, _type: 'episodic' | 'semantic' | 'working'): Promise<unknown[]> { return []; }
}