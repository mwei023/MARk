// src/runtime/router.ts
// Deterministic local-intent recognition shared by the MARK gateway and the
// local-host capability. It classifies only; it does not perform host work.
export type LocalIntent = 
  | { type: 'time' }
  | { type: 'date' }
  | { type: 'files'; path?: string }
  | { type: 'system'; metric: 'disk' | 'memory' | 'cpu' }
  | null;

const INTENT_PATTERNS = [
  { regex: /\b(time|clock|hour|minute)\b/i, type: 'time' },
  { regex: /\b(date|today|day|month|year)\b/i, type: 'date' },
  { regex: /\b(list|show|display|open)\b.*\b(files|file|directory|folder)\b/i, type: 'files' },
  { regex: /\b(disk|storage|df|space)\b/i, type: 'system', metric: 'disk' as const },
  { regex: /\b(memory|ram|free|htop)\b/i, type: 'system', metric: 'memory' as const },
  { regex: /\b(cpu|load|processor)\b/i, type: 'system', metric: 'cpu' as const },
];

export const routeLocally = (input: string): LocalIntent => {
  const lower = input.toLowerCase();
  for (const pattern of INTENT_PATTERNS) {
    if (pattern.regex.test(lower)) {
      const { type, ...rest } = pattern;
      if (type === 'files') {
        return { type: 'files' };
      }
      return { type, ...(rest as any) };
    }
  }
  return null;
};
