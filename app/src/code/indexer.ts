/**
 * Code-aware vector ingestion: chunk repo files with symbol context, embed
 * with nomic-embed-text (768 dims), store in code_chunks (migration 008).
 *
 * Chunking is symbol-aware, not fixed windows: each chunk carries its
 * enclosing definition name so "where is X defined" queries match the chunk
 * that actually defines X. DB + Ollama failures throw — callers (the
 * repo.index tool) convert to fail-closed output; search treats them as
 * "fall back to keyword".
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import { getPool } from '../db/postgres';
import { embeddings } from '../llm/embeddings';
import { extractSymbols, buildFindArgs, runFind } from '../kernel/providers/repo-semantic';

const execFilePromise = promisify(execFile);
const FIND_TIMEOUT = 15000;
const EMBED_TIMEOUT_MS = 30000;
const MAX_FILES = 40;
const MAX_FILE_BYTES = 120_000;
const CHUNK_LINES = 100;

export interface CodeChunk {
  file: string;
  chunkIndex: number;
  symbol: string;
  text: string;
}

const CODE_EXTS = ['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'rb', 'php', 'swift', 'kt', 'scala', 'sh', 'vue', 'html', 'css'];

/** Pure: split content into symbol-annotated chunks. Unit-tested, no I/O. */
export function chunkCode(content: string, relPath: string): CodeChunk[] {
  const lines = content.split('\n');
  const symbols = extractSymbols(content, relPath);
  const chunks: CodeChunk[] = [];
  for (let start = 0; start < lines.length; start += CHUNK_LINES) {
    const end = Math.min(lines.length, start + CHUNK_LINES);
    const enclosing = symbols.filter(s => s.line >= start + 1 && s.line <= end).map(s => s.name);
    const outer = symbols.filter(s => s.line <= start + 1).pop()?.name ?? '';
    const symbol = [...new Set([...(outer ? [outer] : []), ...enclosing])].slice(0, 5).join(',');
    const text = `${relPath}${symbol ? ` [${symbol}]` : ''}\n${lines.slice(start, end).join('\n')}`.slice(0, 8000);
    chunks.push({ file: relPath, chunkIndex: chunks.length, symbol, text });
  }
  return chunks;
}

export async function listCodeFiles(repoPath: string, maxFiles = MAX_FILES): Promise<string[]> {
  const nameArgs: string[] = [];
  for (const ext of CODE_EXTS) nameArgs.push('-name', `*.${ext}`, '-o');
  nameArgs.pop();
  return runFind(buildFindArgs(repoPath, nameArgs)).then(stdout => stdout.split('\n').map(l => l.trim()).filter(Boolean).slice(0, maxFiles));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`embed timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Full ingest: fresh index for one repo. Returns file/chunk counts. */
export async function indexRepo(repoPath: string, repoName: string, maxFiles = 25): Promise<{ files: number; chunks: number }> {
  if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) throw new Error('no local checkout at repoPath');
  const absFiles = await listCodeFiles(repoPath, maxFiles);
  const chunks: CodeChunk[] = [];
  for (const abs of absFiles) {
    const rel = abs.startsWith(repoPath) ? abs.slice(repoPath.length + 1) : abs;
    try {
      const content = readFileSync(abs, 'utf8');
      if (content.length > MAX_FILE_BYTES || content.length === 0) continue;
      chunks.push(...chunkCode(content, rel));
    } catch { continue; }
  }
  if (chunks.length === 0) throw new Error('no indexable code found');
  const pool = getPool();
  await pool.query('DELETE FROM code_chunks WHERE repo = $1', [repoName]);
  let embedded = 0;
  for (const chunk of chunks) {
    const raw = await withTimeout(embeddings.embedQuery(chunk.text.slice(0, 2000)), EMBED_TIMEOUT_MS);
    const vec: number[] = Array.isArray(raw) ? raw.map(v => (typeof v === 'number' ? v : parseFloat(v as string))) : [];
    if (vec.length !== 768) throw new Error(`Expected 768-dim vector, got ${vec.length}`);
    await pool.query(
      'INSERT INTO code_chunks (repo, file, chunk_index, symbol, text, embedding) VALUES ($1, $2, $3, $4, $5, $6::vector)',
      [repoName, chunk.file, chunk.chunkIndex, chunk.symbol, chunk.text, `[${vec.join(',')}]`],
    );
    embedded++;
  }
  return { files: absFiles.length, chunks: embedded };
}

/** Vector search over one repo's chunks. Throws when DB/embeddings unavailable. */
export async function searchCode(repoName: string, query: string, limit = 8): Promise<Array<{ file: string; symbol: string; score: number }>> {
  const raw = await withTimeout(embeddings.embedQuery(query.slice(0, 500)), EMBED_TIMEOUT_MS);
  const vec: number[] = Array.isArray(raw) ? raw.map(v => (typeof v === 'number' ? v : parseFloat(v as string))) : [];
  if (vec.length !== 768) throw new Error(`Expected 768-dim vector, got ${vec.length}`);
  const pool = getPool();
  const result = await pool.query(
    `SELECT file, symbol, 1 - (embedding <=> $1::vector) AS score
     FROM code_chunks WHERE repo = $2 ORDER BY embedding <=> $1::vector LIMIT $3`,
    [`[${vec.join(',')}]`, repoName, Math.min(Math.max(limit, 1), 15)],
  );
  return result.rows.map(r => ({ file: String(r.file).slice(0, 200), symbol: String(r.symbol ?? '').slice(0, 200), score: Number(r.score) }));
}
