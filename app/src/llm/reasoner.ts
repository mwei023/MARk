/**
 * Canonical MARK reasoner: plain LLM chat with deterministic memory
 * augmentation. Replaces the legacy LangGraph adapter as the default
 * reasoning path.
 *
 * Design rules (why the legacy path kept failing live):
 * - The model NEVER calls tools. Memory questions are answered by calling
 *   retrieveContext directly and injecting the notes into the prompt —
 *   deterministic retrieval, no model-emitted function calls, no
 *   provider tool_choice conflicts.
 * - Plain-text-only instruction: the model must not emit JSON or
 *   function-call syntax.
 * - Every external touch (history, retrieval, chat) is best-effort with a
 *   timeout. Failures propagate as errors so MarkRuntime can answer
 *   `unavailable` honestly instead of roleplaying.
 */
import { getLLMProviderCached, Message, LLMProvider } from './index';
import { retrieveContext } from '../rags';
import { getRecentHistory, saveTurn } from '../agent/history';

export interface ReasonerDeps {
  provider?: LLMProvider;
  retrieve?: (query: string) => Promise<string>;
  loadHistory?: (userId: string) => Promise<string>;
  saveHistory?: (userId: string, input: string, response: string) => Promise<void>;
  timeoutMs?: number;
}

const MEMORY_QUESTION = /\b(what'?s my|did i|remind me|my notes?|my favorite|remember about|what did i (say|mention|tell))\b/i;

/**
 * The chat-role prompt. Deliberately claims NO tools: this path can only
 * produce words (the kernel acts before chat ever runs). The old shared
 * prompt advertised "real tools" to a model that cannot call them, which
 * is exactly why tool-inclined models emitted launch_app/rag_query calls
 * and providers rejected them with tool_use_failed.
 */
const REASONER_SYSTEM = `You are MARK, Mwei's local operations assistant, answering in chat.
You cannot run tools, open apps, play media, or act on the machine from here — you produce words only.
- If the user wants something DONE, say so plainly and tell them how to ask so it can run (name the thing and any details, e.g. which app, which file).
- If they ask about their saved notes, use the notes provided in context and paraphrase naturally (e.g. "Your favorite color is blue"); if none were provided, say nothing is saved on that yet.
- Keep answers concise, friendly, and conversational. Never mention tool names or technical details.
- Respond in plain conversational text only. Never emit JSON, tool calls, or function-call syntax under any circumstance.`;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function respondWithLLM(
  input: string,
  userId: string,
  deps: ReasonerDeps = {},
): Promise<string> {
  const timeoutMs = deps.timeoutMs ?? Number(process.env.MARK_LLM_TIMEOUT_MS ?? 45000);
  const provider = deps.provider ?? await withTimeout(getLLMProviderCached(), timeoutMs, 'LLM provider init');

  const [history, notes] = await Promise.all([
    (deps.loadHistory ?? loadHistoryDefault)(userId).catch(() => ''),
    looksLikeMemoryQuestion(input)
      ? (deps.retrieve ?? retrieveDefault)(input).catch(() => '')
      : Promise.resolve(''),
  ]);

  const contextBlocks: string[] = [];
  if (history.trim()) contextBlocks.push(`Recent conversation:\n${history.trim().slice(0, 2000)}`);
  if (notes.trim()) {
    contextBlocks.push(
      `Saved notes relevant to the question (paraphrase naturally, never mention tool names):\n${notes.trim().slice(0, 2000)}`,
    );
  } else if (looksLikeMemoryQuestion(input)) {
    contextBlocks.push('No saved notes matched this question. Say you have nothing saved on that yet.');
  }

  const messages: Message[] = [
    {
      role: 'system',
      content: REASONER_SYSTEM,
    },
    {
      role: 'user',
      content: contextBlocks.length > 0 ? `${contextBlocks.join('\n\n')}\n\nUser: ${input}` : input,
    },
  ];

  // Tool-inclined models sometimes emit a call anyway despite the ban;
  // providers reject it (tool_use_failed). One reinforced retry before
  // giving up — the runtime then answers `unavailable` honestly.
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await withTimeout(provider.chat(attempt === 1 ? messages : reinforced(messages)), timeoutMs, 'LLM chat');
      const text = stripFences(response.content).trim();
      if (!text) throw new Error('LLM returned an empty response');
      await (deps.saveHistory ?? saveHistoryDefault)(userId, input, text).catch(() => {});
      return text;
    } catch (error: any) {
      lastError = error;
      if (!looksLikeToolCallRejection(error) || attempt === 2) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function reinforced(messages: Message[]): Message[] {
  return [
    ...messages,
    {
      role: 'user',
      content: 'Your previous reply was rejected because it contained a tool call or JSON. Reply again in plain sentences only, no JSON, no tool calls.',
    },
  ];
}

function looksLikeToolCallRejection(error: any): boolean {
  const text = `${error?.message || ''} ${String(error)}`.toLowerCase();
  return text.includes('tool') && (text.includes('400') || text.includes('tool_choice') || text.includes('tool_use_failed') || text.includes('function'));
}

export function looksLikeMemoryQuestion(input: string): boolean {
  return MEMORY_QUESTION.test(input || '');
}

function stripFences(content: string): string {
  return (content || '').replace(/^```(?:json)?\n?|\n?```$/g, '').trim();
}

async function loadHistoryDefault(userId: string): Promise<string> {
  return getRecentHistory(userId, 3);
}

async function retrieveDefault(query: string): Promise<string> {
  return retrieveContext(query, 3, undefined, 0.3);
}

async function saveHistoryDefault(userId: string, input: string, response: string): Promise<void> {
  await saveTurn(userId, input, response);
}
