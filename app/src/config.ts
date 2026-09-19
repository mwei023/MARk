/**
 * Centralised typed configuration.
 *
 * Every process.env access in the application should come through here.
 * This keeps all env keys in one place, documents their purpose, and gives
 * TypeScript a typed surface to catch typos.
 *
 * Import: import { config } from '../config.js';
 */
import os from 'os';

function homeDir(): string {
  try {
    return process.env.HOME || os.homedir() || '/home/mwei';
  } catch {
    return '/home/mwei';
  }
}

export interface AppConfig {
  // --- Identity ---
  /** The default user id for CLI / REPL sessions. Override with MARK_DEFAULT_USER. */
  defaultUser: string;

  // --- Database ---
  /** PostgreSQL connection string. Required for incident store and workflow memory. */
  databaseUrl: string | undefined;

  // --- API ---
  /** HTTP port for the REST API server. Default: 3000. */
  apiPort: number;
  /** Bearer token required for API requests. Leave unset to disable auth. */
  apiToken: string | undefined;
  /** Shared secret for verifying GitHub webhook payloads. */
  githubWebhookSecret: string | undefined;

  // --- LLM ---
  /** Primary LLM provider: ollama | openrouter | groq | gemini. Default: ollama. */
  llmProvider: string;
  /** Comma-separated fallback providers when the primary is unavailable. */
  llmFallbackProviders: string[];
  /** LLM inference timeout in milliseconds. Default: 30000. */
  llmTimeoutMs: number;

  // --- Ollama ---
  ollamaHost: string;
  ollamaModel: string;
  ollamaEmbeddingModel: string;

  // --- OpenRouter ---
  openrouterApiKey: string | undefined;
  openrouterModel: string;

  // --- Groq ---
  groqApiKey: string | undefined;
  groqModel: string;

  // --- Gemini ---
  geminiApiKey: string | undefined;
  geminiModel: string;

  // --- Runtime behaviour ---
  /** Set to 'off' to disable LLM-assisted routing. Useful in tests. */
  markSmart: 'on' | 'off';
  /** Set to 'true' to allow low-risk auto-fix actions without approval. */
  markEnableAutofix: boolean;
  /** Set to 'false' to disable workflow memory learning. */
  markLearning: boolean;
  /** Set to 'true' to auto-trust tools after first confirmation. */
  markAutoTrust: boolean;
  /** Set to 'true' to log mutating actions as WOULD HAVE without executing. */
  markDryRun: boolean;
  /** Max LLM repair attempts per incident after deterministic fixes (default 2). */
  markRepairMaxErrors: number;
  /** Skip LLM repair for files larger than this many lines (default 300). */
  markRepairMaxFileLines: number;
  /** Max cloud-LLM repair calls per repair run; local model is always tried first (default 5). */
  markRepairMaxCloudCalls: number;
  /** Ops autonomy level L0 (propose only) .. L4 (objective-driven). Default: 1. */
  opsAutonomyLevel: number;
  /** Max steps per multi-step ops plan (default 4). Caps autonomy per goal. */
  opsMaxPlanSteps: number;
  /**
   * TESTING ONLY — never enable in production. When true: the kernel
   * working-directory jail is bypassed (loud warning logged) and
   * confirmation-gated tools auto-approve with an audit observation.
   * Reversible: unset the env var to restore full enforcement.
   */
  markTestMode: boolean;

  // --- Security ---
  /** Root directory that shell capabilities are allowed to read/write. */
  allowedDataDir: string;
  /** Directories scanned (one level) to find local clones of repos by remote URL. */
  repoRoots: string[];

  // --- Voice ---
  whisperBin: string | undefined;
  whisperModel: string | undefined;
  piperBin: string | undefined;
  piperModel: string | undefined;
  ldLibraryPath: string | undefined;

  // --- System ---
  /** DISPLAY env var for desktop/X11 tools. */
  display: string | undefined;
  /** PATH forwarded to subprocesses. */
  path: string | undefined;
}

function readInt(value: string | undefined, fallback: number): number {
  const n = parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function readBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === 'true' || value === '1';
}

function readList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

export const config: AppConfig = {
  // Identity
  defaultUser: process.env.MARK_DEFAULT_USER ?? 'mark',

  // Database
  databaseUrl: process.env.DATABASE_URL,

  // API
  apiPort: readInt(process.env.API_PORT, 3000),
  apiToken: process.env.API_TOKEN,
  githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET,

  // LLM
  llmProvider: process.env.LLM_PROVIDER ?? 'ollama',
  llmFallbackProviders: readList(process.env.LLM_FALLBACK_PROVIDERS),
  llmTimeoutMs: readInt(process.env.MARK_LLM_TIMEOUT_MS, 30000),

  // Ollama
  ollamaHost: process.env.OLLAMA_HOST ?? 'http://localhost:11434',
  ollamaModel: process.env.OLLAMA_MODEL ?? 'llama3.2:3b',
  ollamaEmbeddingModel: process.env.OLLAMA_EMBEDDING_MODEL ?? 'nomic-embed-text',

  // OpenRouter
  openrouterApiKey: process.env.OPENROUTER_API_KEY,
  openrouterModel: process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini',

  // Groq
  groqApiKey: process.env.GROQ_API_KEY,
  groqModel: process.env.GROQ_MODEL ?? 'llama3-8b-8192',

  // Gemini
  geminiApiKey: process.env.GEMINI_API_KEY,
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-1.5-flash',

  // Runtime behaviour
  markSmart: process.env.MARK_SMART === 'off' ? 'off' : 'on',
  markEnableAutofix: readBool(process.env.MARK_ENABLE_AUTOFIX, false),
  markLearning: readBool(process.env.MARK_LEARNING, true),
  markAutoTrust: readBool(process.env.MARK_AUTO_TRUST, false),
  markDryRun: readBool(process.env.MARK_DRY_RUN, false),
  markRepairMaxErrors: readInt(process.env.MARK_REPAIR_MAX_ERRORS, 2),
  markRepairMaxFileLines: readInt(process.env.MARK_REPAIR_MAX_FILE_LINES, 300),
  markRepairMaxCloudCalls: readInt(process.env.MARK_REPAIR_MAX_CLOUD_CALLS, 5),
  opsAutonomyLevel: Math.min(Math.max(readInt(process.env.MARK_OPS_AUTONOMY_LEVEL, 1), 0), 4),
  opsMaxPlanSteps: Math.min(Math.max(readInt(process.env.MARK_OPS_MAX_PLAN_STEPS, 4), 1), 8),
  markTestMode: readBool(process.env.MARK_TEST_MODE, false),

  // Security
  allowedDataDir: process.env.ALLOWED_DATA_DIR ?? '/tmp/mark-data',
  repoRoots: readList(process.env.MARK_REPO_ROOTS).length > 0
    ? readList(process.env.MARK_REPO_ROOTS)
    : [homeDir()],

  // Voice
  whisperBin: process.env.WHISPER_BIN,
  whisperModel: process.env.WHISPER_MODEL,
  piperBin: process.env.PIPER_BIN,
  piperModel: process.env.PIPER_MODEL,
  ldLibraryPath: process.env.LD_LIBRARY_PATH,

  // System
  display: process.env.DISPLAY,
  path: process.env.PATH,
};
