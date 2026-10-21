// src/runtime/router.ts
// Deterministic local-intent recognition shared by the MARK gateway and the
// local-host capability. It classifies only; it does not perform host work.
import { homedir } from 'node:os';
export type LocalIntent = 
  | { type: 'time' }
  | { type: 'date' }
  | { type: 'files'; path?: string }
  | { type: 'system'; metric: 'disk' | 'memory' | 'cpu' }
  | null;

const INTENT_PATTERNS = [
  { regex: /\b(time|clock|hour|minute)\b/i, type: 'time' },
  { regex: /\b(date|today|day|month|year)\b/i, type: 'date' },
  // Verb-first phrasing ("list files in ~") ...
  { regex: /\b(list|show|display|open|search|find)\b.*\b(files|file|directory|folder)\b/i, type: 'files' },
  // Existential file questions ("are there any mp4 files in my pc") —
  // answered by a local read-only filename find when an extension is
  // named, a directory listing otherwise. Observed live: fell to reasoning,
  // which claimed it had no file access while tools sat idle.
  {
    regex: /\b(?:are there|is there)\b.{0,40}\b(files?|dirs?|directories?|folders?)\b/i,
    type: 'files',
  },
  // ... and inquiry-first phrasing ("what's in the downloads folder") which
  // used to fall through to the reasoning path and falsely claim it could
  // not see the user's files.
  {
    regex: /\bwhat(?:'s|'re| is| are)\b[^.]{0,40}?\b(files?|dirs?|directories?|folders?|drives?)\b/i,
    type: 'files',
  },
  {
    regex: /\banything\b[^.]{0,40}?\b(files?|dirs?|directories?|folders?|drives?)\b/i,
    type: 'files',
  },
  { regex: /\b(disk|storage|df|space)\b/i, type: 'system', metric: 'disk' as const },
  { regex: /\b(memory|ram|free|htop)\b/i, type: 'system', metric: 'memory' as const },
  { regex: /\b(cpu|load|processor)\b/i, type: 'system', metric: 'cpu' as const },
];

// Well-known home subdirectories the user can reference by common name.
// Mirrors the XDG alias map used by the task binder, but kept dependency-free:
// the router must not pull in kernel modules.
const HOME_DIRS: Record<string, string> = {
  downloads: 'Downloads',
  download: 'Downloads',
  documents: 'Documents',
  desktop: 'Desktop',
  pictures: 'Pictures',
  videos: 'Videos',
  music: 'Music',
};
const DIR_NAME_RE = /\b(downloads?|documents?|desktop|pictures?|videos?|music|home)\s+(folder|directory|dir)\b/i;

const extractFilesPath = (input: string): string | undefined => {
  const m = DIR_NAME_RE.exec(input);
  if (!m) {
    // "my home directory" / bare "home folder" also land here via DIR_NAME_RE.
    return undefined;
  }
  const name = m[1].toLowerCase().replace(/s$/, '');
  if (name === 'home') return homedir();
  const sub = HOME_DIRS[name];
  return sub ? `${homedir()}/${sub}` : undefined;
};

export const routeLocally = (input: string): LocalIntent => {
  const lower = input.toLowerCase();
  for (const pattern of INTENT_PATTERNS) {
    if (pattern.regex.test(lower)) {
      const { type, ...rest } = pattern;
      if (type === 'files') {
        // Bind a home-relative target when the user names a real folder
        // ("downloads folder" → $HOME/Downloads). Unbound → caller default.
        return { type: 'files', path: extractFilesPath(input) };
      }
      return { type, ...(rest as any) };
    }
  }
  return null;
};
