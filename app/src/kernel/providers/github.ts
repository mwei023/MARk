/**
 * GitHub provider (github.*): read issues/PRs/releases via the `gh` CLI,
 * post PR comments behind the mutating gate.
 *
 * Fixed argv through execFile (no shell), strict input validation, JSON
 * output parsed and truncated. Reads are risk-read; commenting is
 * risk-mutating (denied by default, confirmation-gated on workspace).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  DiscoveryProvider,
  ToolDescriptor,
  ToolImplementation,
  ToolParameterSchema,
} from '../index';

const execFilePromise = promisify(execFile);
const GH_TIMEOUT = 30000;
const MAX_ITEMS = 30;
const MAX_BODY = 10000;
const COMMENT_MAX = 2000;

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function failOutput(reason: string): Record<string, unknown> {
  return { ok: false, reason: reason.slice(0, 300), capturedAt: new Date().toISOString() };
}

function checkRepo(repo: unknown): string | undefined {
  const r = String(repo ?? '').trim();
  if (!REPO_RE.test(r)) return undefined;
  return r;
}

function checkNumber(n: unknown): number | undefined {
  const v = typeof n === 'number' ? n : Number(String(n ?? '').trim());
  if (!Number.isInteger(v) || v <= 0 || v > 1000000) return undefined;
  return v;
}

function checkLimit(l: unknown): number {
  if (l === undefined || l === null || String(l).trim() === '') return 10;
  const v = typeof l === 'number' ? l : Number(String(l).trim());
  if (!Number.isFinite(v)) return 10;
  return Math.min(Math.max(Math.floor(v), 1), MAX_ITEMS);
}

async function ghJson(args: string[]): Promise<{ ok: boolean; data?: unknown; reason?: string }> {
  try {
    const { stdout } = await execFilePromise('gh', args, { timeout: GH_TIMEOUT, maxBuffer: 4 * 1024 * 1024 });
    try {
      return { ok: true, data: JSON.parse(stdout) };
    } catch {
      return { ok: false, reason: 'gh returned non-JSON output' };
    }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const detail = `${e.stderr ?? ''}`.trim().slice(0, 200) || (e.message ?? 'gh failed').slice(0, 200);
    return { ok: false, reason: `gh failed: ${detail}` };
  }
}

function truncateText(text: string, max = MAX_BODY): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (truncated)`;
}

function readTool(
  id: string,
  name: string,
  description: string,
  properties: Record<string, ToolParameterSchema>,
  required: string[],
): ToolDescriptor {
  return {
    id, name, description, version: '1.0.0', domain: 'github', risk: 'read',
    available: true,
    inputSchema: { type: 'object', properties, required },
    capabilities: ['github-reading', 'code-collaboration'],
    supportedResourceKinds: [],
    requiredPermissions: [],
    reversible: true,
    metadata: {},
    provider: 'github.native',
  };
}

const repoProp: ToolParameterSchema = { type: 'string', description: 'Repository in owner/name form, e.g. cli/cli.' };
const numberProp = (what: string): ToolParameterSchema => ({ type: 'number', description: `${what} number (positive integer).` });
const limitProp: ToolParameterSchema = { type: 'number', description: 'Max items to return (1-30, default 10).' };
const stateProp: ToolParameterSchema = { type: 'string', description: 'open, closed, merged, or all (default open).' };

const VALID_STATES = new Set(['open', 'closed', 'merged', 'all']);

function checkState(s: unknown): string {
  const v = String(s ?? 'open').trim().toLowerCase();
  return VALID_STATES.has(v) ? v : 'open';
}

export const githubIssueGetTool = readTool(
  'github.issue_get', 'Get GitHub issue',
  'Reads a GitHub issue with its title, body, state, labels, and comments. Use to inspect reported bugs and feature requests.',
  { repo: repoProp, number: numberProp('Issue') },
  ['repo', 'number'],
);

export const githubIssueListTool = readTool(
  'github.issue_list', 'List GitHub issues',
  'Lists GitHub issues in a repository with numbers, titles, states, and labels. Use to survey open bugs and requests.',
  { repo: repoProp, limit: limitProp, state: stateProp },
  ['repo'],
);

export const githubPrGetTool = readTool(
  'github.pr_get', 'Get GitHub pull request',
  'Reads a GitHub pull request with title, body, state, reviews, and changed files. Use to review proposed code changes.',
  { repo: repoProp, number: numberProp('Pull request') },
  ['repo', 'number'],
);

export const githubPrListTool = readTool(
  'github.pr_list', 'List GitHub pull requests',
  'Lists GitHub pull requests in a repository with numbers, titles, states, and review decisions. Use to survey proposed changes awaiting review.',
  { repo: repoProp, limit: limitProp, state: stateProp },
  ['repo'],
);

export const githubReleaseListTool = readTool(
  'github.release_list', 'List GitHub releases',
  'Lists recent GitHub releases with versions and dates. Use to check what shipped recently and when.',
  { repo: repoProp, limit: limitProp },
  ['repo'],
);

export const githubRepoInfoTool = readTool(
  'github.repo_info', 'Get repository info',
  'Reads repository metadata: description, stars, default branch, open issue and pull request counts. Use to orient before working in a repo.',
  { repo: repoProp },
  ['repo'],
);

export const githubPrCommentTool: ToolDescriptor = {
  id: 'github.pr_comment',
  name: 'Comment on pull request',
  description:
    'Posts a review comment on a GitHub pull request. Mutating: needs confirmation outside test mode.',
  version: '1.0.0', domain: 'github', risk: 'mutating',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      repo: repoProp,
      number: numberProp('Pull request'),
      body: { type: 'string', description: 'Comment text (max 2000 chars).' },
    },
    required: ['repo', 'number', 'body'],
  },
  capabilities: ['github-writing', 'code-collaboration'],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: false,
  metadata: {},
  provider: 'github.native',
};

async function runGet(
  kind: 'issue' | 'pr',
  input: Record<string, unknown>,
  fields: string,
): Promise<{ output: Record<string, unknown> }> {
  const repo = checkRepo(input.repo);
  const number = checkNumber(input.number);
  if (!repo) return { output: failOutput('repo must be owner/name.') };
  if (number === undefined) return { output: failOutput('number must be a positive integer.') };
  const r = await ghJson([kind, 'view', String(number), '--repo', repo, '--json', fields]);
  if (!r.ok) return { output: failOutput(r.reason ?? 'fetch failed') };
  const data = r.data as Record<string, unknown>;
  if (typeof data.body === 'string') data.body = truncateText(data.body);
  if (Array.isArray(data.comments)) {
    data.comments = (data.comments as Array<Record<string, unknown>>).slice(-10).map(c => ({
      ...c,
      body: typeof c.body === 'string' ? truncateText(c.body, 2000) : c.body,
    }));
  }
  if (Array.isArray(data.files)) {
    data.files = (data.files as Array<Record<string, unknown>>).slice(0, 50);
  }
  if (Array.isArray(data.reviews)) {
    data.reviews = (data.reviews as Array<Record<string, unknown>>).slice(-20);
  }
  return { output: { ok: true, kind, repo, number, ...(data as object), capturedAt: new Date().toISOString() } };
}

async function runList(
  kind: 'issue' | 'pr' | 'release',
  input: Record<string, unknown>,
): Promise<{ output: Record<string, unknown> }> {
  const repo = checkRepo(input.repo);
  if (!repo) return { output: failOutput('repo must be owner/name.') };
  const limit = checkLimit(input.limit);
  let args: string[];
  if (kind === 'release') {
    args = ['release', 'list', '--repo', repo, '--limit', String(limit), '--json', 'name,tagName,publishedAt,createdAt,isLatest'];
  } else {
    args = [kind, 'list', '--repo', repo, '--limit', String(limit), '--state', checkState(input.state),
      '--json', 'number,title,state,labels,author,createdAt'];
  }
  const r = await ghJson(args);
  if (!r.ok) return { output: failOutput(r.reason ?? 'fetch failed') };
  const items = Array.isArray(r.data) ? r.data : [];
  return { output: { ok: true, kind, repo, count: items.length, items, capturedAt: new Date().toISOString() } };
}

export const githubIssueGetImplementation: ToolImplementation = {
  toolId: githubIssueGetTool.id,
  async execute({ action }) {
    return runGet('issue', action.input as Record<string, unknown>, 'number,title,body,state,labels,author,comments,createdAt,url');
  },
};

export const githubIssueListImplementation: ToolImplementation = {
  toolId: githubIssueListTool.id,
  async execute({ action }) {
    return runList('issue', action.input as Record<string, unknown>);
  },
};

export const githubPrGetImplementation: ToolImplementation = {
  toolId: githubPrGetTool.id,
  async execute({ action }) {
    return runGet('pr', action.input as Record<string, unknown>, 'number,title,body,state,labels,author,files,reviews,reviewDecision,additions,deletions,createdAt,url');
  },
};

export const githubPrListImplementation: ToolImplementation = {
  toolId: githubPrListTool.id,
  async execute({ action }) {
    return runList('pr', action.input as Record<string, unknown>);
  },
};

export const githubReleaseListImplementation: ToolImplementation = {
  toolId: githubReleaseListTool.id,
  async execute({ action }) {
    return runList('release', action.input as Record<string, unknown>);
  },
};

export const githubReleaseGetTool = readTool(
  'github.release_get', 'Get GitHub release',
  'Reads one GitHub release with its notes by version tag. Use to inspect what a specific release shipped.',
  { repo: repoProp, tag: { type: 'string', description: 'Release version tag, e.g. v2.4.0.' } },
  ['repo', 'tag'],
);

export const githubReleaseGetImplementation: ToolImplementation = {
  toolId: githubReleaseGetTool.id,
  async execute({ action }) {
    const input = action.input as Record<string, unknown>;
    const repo = checkRepo(input.repo);
    const tag = String(input.tag ?? '').trim();
    if (!repo) return { output: failOutput('repo must be owner/name.') };
    if (!tag || tag.length > 100 || /[\s;|&$`]/.test(tag)) return { output: failOutput('tag must be a plain version string.') };
    try {
      const { stdout } = await execFilePromise('gh', ['release', 'view', tag, '--repo', repo, '--json', 'name,tagName,body,publishedAt,url'], { timeout: GH_TIMEOUT });
      const data = JSON.parse(stdout) as Record<string, unknown>;
      if (typeof data.body === 'string') data.body = truncateText(data.body);
      return { output: { ok: true, repo, ...(data as object), capturedAt: new Date().toISOString() } };
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      return { output: failOutput(`gh release view failed: ${(e.stderr ?? e.message ?? 'unknown').slice(0, 200)}`) };
    }
  },
};

export const githubRepoInfoImplementation: ToolImplementation = {
  toolId: githubRepoInfoTool.id,
  async execute({ action }) {
    const repo = checkRepo((action.input as Record<string, unknown>).repo);
    if (!repo) return { output: failOutput('repo must be owner/name.') };
    const r = await ghJson(['repo', 'view', repo, '--json', 'name,description,stargazerCount,forkCount,defaultBranchRef,url,createdAt']);
    if (!r.ok) return { output: failOutput(r.reason ?? 'fetch failed') };
    return { output: { ok: true, repo, ...(r.data as object), capturedAt: new Date().toISOString() } };
  },
};

export const githubPrCommentImplementation: ToolImplementation = {
  toolId: githubPrCommentTool.id,
  async execute({ action }) {
    const input = action.input as Record<string, unknown>;
    const repo = checkRepo(input.repo);
    const number = checkNumber(input.number);
    const body = String(input.body ?? '');
    if (!repo) return { output: failOutput('repo must be owner/name.') };
    if (number === undefined) return { output: failOutput('number must be a positive integer.') };
    if (!body.trim()) return { output: failOutput('comment body is required.') };
    if (body.length > COMMENT_MAX) return { output: failOutput(`comment exceeds ${COMMENT_MAX} chars.`) };
    try {
      await execFilePromise('gh', ['pr', 'comment', String(number), '--repo', repo, '--body', body], { timeout: GH_TIMEOUT });
      return { output: { ok: true, repo, number, capturedAt: new Date().toISOString() } };
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      return { output: failOutput(`gh comment failed: ${(e.stderr ?? e.message ?? 'unknown').slice(0, 200)}`) };
    }
  },
};

export const githubTools: ToolDescriptor[] = [
  githubIssueGetTool, githubIssueListTool, githubPrGetTool, githubPrListTool,
  githubReleaseListTool, githubReleaseGetTool, githubRepoInfoTool, githubPrCommentTool,
];
export const githubImplementations: ToolImplementation[] = [
  githubIssueGetImplementation, githubIssueListImplementation, githubPrGetImplementation,
  githubPrListImplementation, githubReleaseListImplementation, githubReleaseGetImplementation,
  githubRepoInfoImplementation, githubPrCommentImplementation,
];

export const githubDiscoveryProvider: DiscoveryProvider = {
  id: 'github.native',
  name: 'GitHub provider',
  description: 'Reads GitHub issues, pull requests, and releases; comments on pull requests with approval.',
  priority: 80,
  async isAvailable(): Promise<boolean> {
    return true;
  },
  async discoverResources(): Promise<never[]> {
    return [];
  },
  async discoverTools(): Promise<ToolDescriptor[]> {
    return githubTools;
  },
};
