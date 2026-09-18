import { existsSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { getPool } from '../db/postgres';
import { config } from '../config.js';

export type RepositoryProvider = 'github';

export interface MonitoredRepository {
  id: string;
  provider: RepositoryProvider;
  owner: string;
  name: string;
  fullName: string;
  localPath?: string;
  defaultBranch?: string;
  enabled: boolean;
  source: 'config' | 'auto' | 'webhook';
  createdAt: Date;
}

export const normalizeRepositoryFullName = (value?: string | null): string => {
  if (!value) return '';
  let formatted = value.trim().replace(/\.git$/i, '').replace(/\\/g, '/');

  if (formatted.startsWith('https://github.com/')) {
    formatted = formatted.replace(/^https?:\/\/github\.com\//i, '');
  } else if (formatted.startsWith('git@github.com:')) {
    formatted = formatted.replace(/^git@github\.com:/i, '');
  } else if (formatted.startsWith('ssh://git@github.com/')) {
    formatted = formatted.replace(/^ssh:\/\/git@github\.com\//i, '');
  } else if (formatted.startsWith('github.com/')) {
    formatted = formatted.replace(/^github\.com\//i, '');
  }

  const parts = formatted.split('/').map(part => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }

  return formatted;
};

const getGitRemoteUrl = (localPath: string): string | null => {
  try {
    const raw = execSync(`git -C "${localPath}" remote get-url origin`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    }).toString().trim();
    return raw || null;
  } catch {
    return null;
  }
};

export class RepositoryRegistry {
  private readonly repos = new Map<string, MonitoredRepository>();

  private persistRepository(repo: MonitoredRepository): void {
    try {
      const pool = getPool();
      pool.query(`
        INSERT INTO monitored_repositories (
          id, provider, owner, name, full_name, local_path, default_branch, enabled, source, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (full_name) DO UPDATE SET
          local_path = EXCLUDED.local_path,
          default_branch = EXCLUDED.default_branch,
          enabled = EXCLUDED.enabled,
          source = EXCLUDED.source,
          updated_at = NOW()
      `, [
        repo.id,
        repo.provider,
        repo.owner,
        repo.name,
        repo.fullName,
        repo.localPath || null,
        repo.defaultBranch || 'main',
        repo.enabled,
        repo.source,
        repo.createdAt,
      ]).catch(() => {});
    } catch {
      // DATABASE_URL may not be configured in local-only testing environments.
    }
  }

  async loadFromDatabase(): Promise<MonitoredRepository[]> {
    try {
      const pool = getPool();
      const result = await pool.query(`
        SELECT * FROM monitored_repositories WHERE enabled = true ORDER BY full_name ASC
      `);

      for (const row of result.rows) {
        const repo: MonitoredRepository = {
          id: row.id,
          provider: row.provider,
          owner: row.owner,
          name: row.name,
          fullName: row.full_name,
          localPath: row.local_path || undefined,
          defaultBranch: row.default_branch || 'main',
          enabled: row.enabled,
          source: row.source,
          createdAt: row.created_at,
        };
        this.repos.set(repo.fullName, repo);
        if (repo.localPath) {
          this.repos.set(repo.localPath, repo);
        }
      }
      return this.list();
    } catch {
      return this.list();
    }
  }

  register(repo: Omit<MonitoredRepository, 'id' | 'createdAt'> & { id?: string; createdAt?: Date }): MonitoredRepository {
    const fullName = normalizeRepositoryFullName(repo.fullName || `${repo.owner}/${repo.name}`);
    const normalized: MonitoredRepository = {
      id: repo.id ?? fullName,
      provider: repo.provider ?? 'github',
      owner: repo.owner ?? fullName.split('/')[0],
      name: repo.name ?? fullName.split('/')[1],
      fullName,
      localPath: repo.localPath,
      defaultBranch: repo.defaultBranch,
      enabled: repo.enabled ?? true,
      source: repo.source ?? 'config',
      createdAt: repo.createdAt ?? new Date(),
    };

    this.repos.set(normalized.fullName, normalized);
    if (normalized.localPath) {
      this.repos.set(normalized.localPath, normalized);
    }

    this.persistRepository(normalized);
    return normalized;
  }

  list(): MonitoredRepository[] {
    return [...new Map(Array.from(this.repos.values()).map(repo => [repo.fullName, repo])).values()];
  }

  resolve(reference?: string | null, localPath?: string): MonitoredRepository | null {
    const candidates = new Set<string>();

    if (reference) candidates.add(reference);
    const normalizedRef = normalizeRepositoryFullName(reference);
    if (normalizedRef) candidates.add(normalizedRef);
    if (localPath) candidates.add(localPath);

    for (const candidate of candidates) {
      const exact = this.repos.get(candidate);
      if (exact) return exact;

      const byFullName = this.findByFullName(normalizeRepositoryFullName(candidate));
      if (byFullName) return byFullName;

      const byPath = this.findByLocalPath(candidate);
      if (byPath) return byPath;
    }

    const localCandidate = localPath || reference;
    if (localCandidate && existsSync(localCandidate)) {
      return this.autoRegisterLocalRepo(localCandidate);
    }

    // Last resort: scan the machine for a clone whose origin matches.
    const wanted = normalizeRepositoryFullName(reference);
    if (wanted.includes('/')) {
      return this.findLocalClone(wanted);
    }

    return null;
  }

  findByFullName(fullName?: string | null): MonitoredRepository | null {
    if (!fullName) return null;
    const normalized = normalizeRepositoryFullName(fullName);
    return this.list().find(repo => repo.fullName === normalized) ?? null;
  }

  findByLocalPath(localPath?: string | null): MonitoredRepository | null {
    if (!localPath) return null;
    return this.list().find(repo => repo.localPath && repo.localPath === localPath) ?? null;
  }

  /**
   * Find a local clone of a repo by scanning configured roots (one level).
   * Answers "find the portfolio folder in my pc": matches directories whose
   * git origin remote normalizes to the requested full name. Bounded
   * (max 100 entries per root, 5s per remote lookup); failures skip silently.
   */
  findLocalClone(fullName: string, roots: string[] = config.repoRoots): MonitoredRepository | null {
    const wanted = normalizeRepositoryFullName(fullName);
    if (!wanted || !wanted.includes('/')) return null;
    for (const root of roots.slice(0, 5)) {
      let entries: string[];
      try {
        entries = readdirSync(root, { withFileTypes: true })
          .filter(e => e.isDirectory() && !e.name.startsWith('.'))
          .map(e => e.name)
          .slice(0, 100);
      } catch {
        continue;
      }
      for (const name of entries) {
        const candidate = `${root}/${name}`;
        if (!existsSync(`${candidate}/.git`)) continue;
        let remote: string | null = null;
        try {
          remote = execSync(`git -C "${candidate}" remote get-url origin`, {
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 5000,
          }).toString().trim() || null;
        } catch {
          continue;
        }
        if (remote && normalizeRepositoryFullName(remote) === wanted) {
          return this.autoRegisterLocalRepo(candidate);
        }
      }
    }
    return null;
  }

  autoRegisterLocalRepo(localPath: string): MonitoredRepository | null {    if (!existsSync(localPath)) return null;

    const remoteUrl = getGitRemoteUrl(localPath);
    if (!remoteUrl) return null;

    const fullName = normalizeRepositoryFullName(remoteUrl);
    if (!fullName) return null;

    const repo = this.findByFullName(fullName) ?? this.register({
      id: fullName,
      provider: 'github',
      owner: fullName.split('/')[0],
      name: fullName.split('/')[1],
      fullName,
      localPath,
      enabled: true,
      source: 'auto',
      defaultBranch: 'main',
    });

    if (repo.localPath !== localPath) {
      repo.localPath = localPath;
    }
    return repo;
  }
}

export const repositoryRegistry = new RepositoryRegistry();
