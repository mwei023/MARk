import { createKernelId } from './execution-context';
import { getPool } from '../db/postgres';
import { embeddings } from '../llm/embeddings';

export interface Episode {
  id: string;
  toolId: string;
  status: string;
  summary: string;
  goal?: string;
  error?: string;
  similarity?: number;
  createdAt: string;
}

export interface RecordEpisodeInput {
  toolId: string;
  status: string;
  summary: string;
  goal?: string;
  error?: string;
}

const MAX_EPISODES = 2000;

/**
 * Episodic learning memory: every action outcome becomes a searchable
 * episode. Recording is fire-and-forget (never slows the hot path, never
 * throws); recall is semantic (pgvector over local Ollama embeddings).
 *
 * Silent no-op when the database or embeddings are unavailable (tests,
 * offline) — memory degrades to nothing, never to an error.
 */
export class EpisodeMemory {
  private readonly pending = new Set<Promise<unknown>>();

  async record(input: RecordEpisodeInput): Promise<Episode | undefined> {
    const task = this.doRecord(input);
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
    return task;
  }

  /** Await in-flight records — CLI calls this before exit; servers don't need to. */
  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled(Array.from(this.pending));
    }
  }

  private async doRecord(input: RecordEpisodeInput): Promise<Episode | undefined> {
    try {
      if (process.env.MARK_LEARNING === 'off') return undefined;
      const summary = input.summary.slice(0, 1000);
      const vector = await embeddings.embedQuery(summary);
      const clean: number[] = Array.isArray(vector)
        ? vector.map(v => (typeof v === 'number' ? v : parseFloat(v as any)))
        : [];
      if (clean.length === 0) return undefined;
      const id = createKernelId('episode');
      const literal = `[${clean.join(',')}]`;
      await getPool().query(
        `INSERT INTO episode_memory (id, tool_id, status, summary, goal, error, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
        [id, input.toolId, input.status, summary, input.goal ?? null, input.error?.slice(0, 1000) ?? null, literal],
      );
      return {
        id,
        toolId: input.toolId,
        status: input.status,
        summary,
        goal: input.goal,
        error: input.error,
        createdAt: new Date().toISOString(),
      };
    } catch {
      return undefined;
    }
  }

  async recallSimilar(text: string, limit = 3): Promise<Episode[]> {
    try {
      if (process.env.MARK_LEARNING === 'off') return [];
      const vector = await embeddings.embedQuery(text.slice(0, 1000));
      const clean: number[] = Array.isArray(vector)
        ? vector.map(v => (typeof v === 'number' ? v : parseFloat(v as any)))
        : [];
      if (clean.length === 0) return [];
      const literal = `[${clean.join(',')}]`;
      const result = await getPool().query(
        `SELECT id, tool_id, status, summary, goal, error, created_at,
                1 - (embedding <-> $1::vector) AS similarity
         FROM episode_memory
         WHERE embedding IS NOT NULL
         ORDER BY embedding <-> $1::vector
         LIMIT $2`,
        [literal, limit],
      );
      return result.rows.map(row => ({
        id: row.id,
        toolId: row.tool_id,
        status: row.status,
        summary: row.summary,
        goal: row.goal ?? undefined,
        error: row.error ?? undefined,
        similarity: Number(row.similarity),
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
      }));
    } catch {
      return [];
    }
  }

  async count(): Promise<number> {
    try {
      const result = await getPool().query('SELECT COUNT(*)::int AS n FROM episode_memory');
      return result.rows[0]?.n ?? 0;
    } catch {
      return 0;
    }
  }

  /** Keep the table bounded; called on bridge init, not on the hot path. */
  async prune(): Promise<void> {
    try {
      await getPool().query(
        `DELETE FROM episode_memory WHERE id NOT IN (
           SELECT id FROM episode_memory ORDER BY created_at DESC LIMIT $1
         )`,
        [MAX_EPISODES],
      );
    } catch {
      // Best effort.
    }
  }
}

export const episodeMemory = new EpisodeMemory();
