/**
 * Project index: which local directories look like the user's projects.
 *
 * The gateway and GitAgent need to tell "institution OS project" (a
 * checkout in $HOME) from "the operating system" (machine inspection)
 * without an LLM round-trip. This module scans the configured repo roots
 * one level deep (names only, cached 60s — sub-millisecond hot path) and
 * matches normalized mentions against normalized directory names.
 *
 * A directory counts as project-ish with .git, package.json, index.html,
 * or a recognized project marker — so ~/Music never hijacks "play some
 * music", while ~/MyPortfolio resolves even without a git remote.
 * Matching is pure string normalization (strip case, spaces, -, _);
 * disambiguation (two portfolios) is left to the caller, never guessed.
 */
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { config } from '../config.js';

export interface ProjectDir {
  name: string;
  localPath: string;
  projectish: boolean;
}

const PROJECT_MARKERS = ['.git', 'package.json', 'index.html', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle'];

let cache: { atMs: number; dirs: ProjectDir[] } | null = null;
const CACHE_TTL_MS = 60000;

function roots(): string[] {
  // MARK_REPO_ROOTS is read live (not frozen at import) so tests can
  // point the index at scratch directories; production default is home.
  const raw = process.env.MARK_REPO_ROOTS ?? '';
  const fromEnv = raw.split(/[:,]/).map(s => s.trim()).filter(Boolean).slice(0, 5);
  if (fromEnv.length > 0) return [...new Set(fromEnv)];
  const configured = Array.isArray(config.repoRoots) ? config.repoRoots : [];
  const list = (configured.length > 0 ? configured : [homedir()]).slice(0, 5);
  return [...new Set(list)];
}

/** Normalize for comparison: lowercase, alphanumeric only. */
export function normalizeProjectName(value: string): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function listProjectDirs(): ProjectDir[] {
  if (cache && Date.now() - cache.atMs < CACHE_TTL_MS) return cache.dirs;
  const dirs: ProjectDir[] = [];
  for (const root of roots()) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => e.name)
        .slice(0, 200);
    } catch {
      continue;
    }
    for (const name of entries) {
      const localPath = join(root, name);
      let projectish = false;
      try {
        for (const marker of PROJECT_MARKERS) {
          if (existsSync(join(localPath, marker))) {
            projectish = true;
            break;
          }
        }
      } catch {
        // Unreadable directory — listed but not project-ish.
      }
      dirs.push({ name, localPath, projectish });
    }
  }
  cache = { atMs: Date.now(), dirs };
  return dirs;
}

/** For tests: drop the cached scan. */
export function clearProjectCache(): void {
  cache = null;
}

/**
 * Find project dirs mentioned in free text. A directory matches when its
 * normalized name is a substring of the normalized command (so
 * "institution OS project" finds "institution-os"). Returns project-ish
 * matches first, then plain name matches.
 */
export function findProjectDirs(command: string, projectishOnly = true): ProjectDir[] {
  const norm = normalizeProjectName(command);
  if (norm.length < 3) return [];
  const hits = listProjectDirs().filter(d => {
    const dirNorm = normalizeProjectName(d.name);
    if (dirNorm.length < 3) return false;
    return norm.includes(dirNorm);
  });
  const projectish = hits.filter(d => d.projectish);
  const rest = hits.filter(d => !d.projectish);
  const ordered = [...projectish, ...rest];
  return projectishOnly ? ordered.filter(d => d.projectish || hasProjectWord(command)) : ordered;
}

/**
 * Ranked project matches: a literal spaced-name mention ("my portfolio"
 * for MyPortfolio) outranks a bare normalized substring ("portfolio" also
 * matching peter-mwei-portfolio). Returns best first for disambiguation.
 */
export function rankedProjectDirs(command: string): ProjectDir[] {
  const scored = findProjectDirs(command, false).map(d => ({ d, score: spacedMention(command, d.name) ? 2 : 1 }));
  scored.sort((a, b) => b.score - a.score || Number(b.d.projectish) - Number(a.d.projectish));
  return scored.map(s => s.d);
}

/**
 * True when the directory name appears in the command as contiguous words,
 * separators ignored ("my portfolio" matches MyPortfolio; "institution os"
 * matches institution-os). A bare substring ("portfolio" inside "my
 * portfolio") does NOT make peter-mwei-portfolio exact.
 */
export function spacedMention(command: string, dirName: string): boolean {
  const cmdWords = command.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const dirNorm = normalizeProjectName(dirName);
  if (!dirNorm) return false;
  for (let i = 0; i < cmdWords.length; i++) {
    let joined = '';
    for (let j = i; j < Math.min(i + 5, cmdWords.length); j++) {
      joined += cmdWords[j];
      if (joined === dirNorm) return true;
      if (joined.length >= dirNorm.length) break;
    }
  }
  return false;
}

/** Explicit project-reference words: portfolio, project, repo. */
export function hasProjectWord(command: string): boolean {
  return /\b(portfolios?|projects?|repos?|repositories)\b/i.test(command);
}
