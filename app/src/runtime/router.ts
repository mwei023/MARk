// src/runtime/router.ts
export type LocalIntent = 
  | { type: 'time' }
  | { type: 'date' }
  | { type: 'files'; path?: string }
  | { type: 'memory'; query: string }
  | { type: 'system'; metric: 'disk' | 'memory' | 'cpu' }
  | null;

const INTENT_PATTERNS = [
  { regex: /\b(time|clock|hour|minute)\b/i, type: 'time' },
  { regex: /\b(date|today|day|month|year)\b/i, type: 'date' },
  { regex: /\b(list files|show files|ls|directory|folder)\b/i, type: 'files' },
  { regex: /\b(disk|storage|df|space)\b/i, type: 'system', metric: 'disk' as const },
  { regex: /\b(memory|ram|free|htop)\b/i, type: 'system', metric: 'memory' as const },
  { regex: /\b(cpu|load|processor)\b/i, type: 'system', metric: 'cpu' as const },
  { regex: /\b(remember|recall|what did I|my favorite|my notes)\b/i, type: 'memory' },
];

export const routeLocally = (input: string): LocalIntent => {
  const lower = input.toLowerCase();
  for (const pattern of INTENT_PATTERNS) {
    if (pattern.regex.test(lower)) {
      const { type, ...rest } = pattern;
      if (type === 'memory') {
        return { type: 'memory', query: input };
      }
      if (type === 'files') {
        return { type: 'files', path: pattern.regex.test(lower) ? process.env.HOME : undefined };
      }
      return { type, ...(rest as any) };
    }
  }
  return null;
};

export const executeLocal = async (intent: NonNullable<LocalIntent>): Promise<string> => {
  switch (intent.type) {
    case 'time':
      return `It's ${new Date().toLocaleTimeString('en-KE', { timeZone: 'Africa/Nairobi' })}.`;
    case 'date':
      return `Today is ${new Date().toLocaleDateString('en-KE', { timeZone: 'Africa/Nairobi', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`;
    case 'system': {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execPromise = promisify(exec);
      const cmd = intent.metric === 'disk' ? 'df -h /' : intent.metric === 'memory' ? 'free -h' : 'uptime';
      const { stdout } = await execPromise(cmd);
      return stdout.trim().slice(0, 500);
    }
    case 'files': {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execPromise = promisify(exec);
      const path = intent.path || process.env.HOME || '/home/mwei';
      const { stdout } = await execPromise(`ls -la "${path}"`);
      return stdout.trim().slice(0, 800);
    }
    case 'memory': {
      // Instant RAG fallback (no LLM)
      const { retrieveContext } = await import('../rags');
      const results = await retrieveContext(intent.query, 3, undefined, 0.3);
      return results ? `📚 Found: ${results}` : "📭 No matching notes found.";
    }
    default: return null as any;
  }
};