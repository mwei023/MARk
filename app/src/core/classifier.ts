/**
 * LLM-backed intent classification. Used ONLY when the deterministic
 * keyword gateway cannot claim a command (reasoning/escalate paths):
 * deterministic and agent routes stay fast, local, and test-stable.
 *
 * Returns null on any failure (offline, timeout, unparseable, low
 * confidence) — the caller keeps the keyword decision. Never throws.
 */
import { getLLMProviderCached, LLMProvider, Message } from '../llm';
import { RoutingDecision } from './gateway';

export interface ClassifiedIntent extends RoutingDecision {
  confidence: number;
}

export interface ClassifierDeps {
  provider?: LLMProvider;
  timeoutMs?: number;
  minConfidence?: number;
}

const KNOWN_AGENTS = ['git-agent', 'devops-agent', 'cicd-agent'];
const VALID_PATHS = ['deterministic', 'agent', 'reasoning', 'escalate'];

const CLASSIFIER_SYSTEM = `You route user commands for MARK, a local operations assistant. Reply with EXACTLY one JSON object, no other text:
{"path": "deterministic|agent|reasoning|escalate", "agent": "git-agent|devops-agent|cicd-agent|null", "priority": "low|normal|high|critical", "reasoning": "short reason", "confidence": 0.0-1.0}

Routes:
- deterministic: answerable locally with NO tools and NO agents — current time/date, listing files, disk/memory/cpu snapshots, MARK's own configuration. SHALLOW snapshots only. Any question involving comparison, measurement, ranking, or finding what is biggest/most/eating/filling/using up disk space -> reasoning (a measurement step runs before chat, and chat alone cannot measure). When torn between deterministic and reasoning for a measurement-flavored question, choose reasoning.
- agent: git/branch/commit -> git-agent; deploy/rollback/restart/docker/container/health -> devops-agent; pipeline/build/test/lint failures -> cicd-agent.
- reasoning: explanations, general knowledge, chat, greetings, vague goals ("help", "hi i need help"), anything needing thought before action.
- escalate: empty, dangerous, or incomprehensible requests.

Be conservative: when torn between acting and chatting, choose reasoning with high confidence. Greetings are always reasoning with confidence >= 0.9.`;

export async function classifyWithLLM(
  command: string,
  deps: ClassifierDeps = {},
): Promise<ClassifiedIntent | null> {
  try {
    if (!command?.trim()) return null;
    const timeoutMs = deps.timeoutMs ?? Number(process.env.MARK_LLM_TIMEOUT_MS ?? 30000);
    const minConfidence = deps.minConfidence ?? 0.6;
    const provider = deps.provider ?? await withTimeout(getLLMProviderCached(), timeoutMs, 'LLM provider init');

    const messages: Message[] = [
      { role: 'system', content: CLASSIFIER_SYSTEM },
      { role: 'user', content: `Route this command: ${command.slice(0, 500)}` },
    ];
    const response = await withTimeout(provider.chat(messages, { temperature: 0 }), timeoutMs, 'LLM classify');
    const parsed = parseDecision(response.content);
    if (!parsed || parsed.confidence < minConfidence) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseDecision(content: string): ClassifiedIntent | null {
  try {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const raw = JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>;
    if (!VALID_PATHS.includes(String(raw.path))) return null;
    const path = String(raw.path) as ClassifiedIntent['path'];
    const agent = typeof raw.agent === 'string' && KNOWN_AGENTS.includes(raw.agent) ? raw.agent : undefined;
    if (path === 'agent' && !agent) return null;
    const priority = ['low', 'normal', 'high', 'critical'].includes(String(raw.priority))
      ? (String(raw.priority) as ClassifiedIntent['priority'])
      : 'normal';
    const confidence = Number(raw.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
    return {
      path,
      agent,
      needsLLM: path === 'reasoning',
      priority,
      reasoning: typeof raw.reasoning === 'string' ? raw.reasoning.slice(0, 300) : 'LLM classification',
      confidence,
    };
  } catch {
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
