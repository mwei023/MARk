// src/runtime/router.ts
// Deterministic local-intent recognition shared by the MARK gateway and the
// local-host capability. It classifies only; it does not perform host work.
import { homedir } from 'node:os';
export type LocalIntent = 
  | { type: 'time' }
  | { type: 'date' }
  | { type: 'files'; path?: string; name?: string }
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
  // Machine-wide filename search: "find thor in this pc", "search for my
  // cv on this computer". The user is looking for FILES NAMED ~term, which
  // the local capability answers with a read-only find (observed live:
  // fell to the kernel, resolved a desktop app-finder GUI, and asked for
  // approval to open a window instead of finding anything). The machine
  // phrase is REQUIRED — plain "find X" stays with the kernel/reasoning.
  {
    regex: /\b(?:find|locate|look for)\b\s+(?:the\s+|my\s+|a\s+)?([a-z0-9][a-z0-9 ._-]{0,29})\s+(?:in|on|across)\s+(?:this|my|the)\s+(?:pc|computer|machine|device|laptop)\b/i,
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

// "find thor in this pc" → search term "thor" (machine-phrase required by
// the matching regex, so this extractor only sees qualified goals).
const MACHINE_FIND_RE = /\b(?:find|locate|look for)\b\s+(?:the\s+|my\s+|a\s+)?([a-z0-9][a-z0-9 ._-]{0,29})\s+(?:in|on|across)\s+(?:this|my|the)\s+(?:pc|computer|machine|device|laptop)\b/i;

const extractFileName = (input: string): string | undefined => {
  const m = MACHINE_FIND_RE.exec(input);
  if (!m) return undefined;
  const name = m[1].trim().toLowerCase();
  // Drop empty/cargo-cult terms; keep it a real search term.
  return /^[a-z0-9]/.test(name) && name.length >= 2 ? name : undefined;
};

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
        const path = extractFilesPath(input);
        const name = extractFileName(input);
        return { type: 'files', path, name };
      }
      return { type, ...(rest as any) };
    }
  }
  return null;
};
