import { describe, it, expect } from 'vitest';
import {
  githubIssueGetImplementation,
  githubIssueListImplementation,
  githubPrGetImplementation,
  githubPrCommentImplementation,
  githubReleaseListImplementation,
  githubRepoInfoImplementation,
  githubTools,
} from './providers/github.js';

const act = (toolId: string, input: Record<string, unknown>) =>
  ({ id: 'ACT-test', toolId, input, requestedBy: 'test', createdAt: new Date().toISOString() }) as any;
const ctx = { workingDirectory: '/tmp', userId: 'test', source: 'system' } as any;

describe('github tools validation (offline)', () => {
  it('exposes 8 tools with read/comment risk split', () => {
    expect(githubTools.map(t => t.id)).toEqual([
      'github.issue_get', 'github.issue_list', 'github.pr_get', 'github.pr_list',
      'github.release_list', 'github.release_get', 'github.repo_info', 'github.pr_comment',
    ]);
    expect(githubTools.filter(t => t.risk === 'read')).toHaveLength(7);
    expect(githubTools.find(t => t.id === 'github.pr_comment')?.risk).toBe('mutating');
  });

  it('refuses malformed repo/number without network', async () => {
    const bad = [
      [githubIssueGetImplementation, { repo: 'nope', number: 1 }],
      [githubIssueGetImplementation, { repo: 'a/b', number: -3 }],
      [githubIssueListImplementation, { repo: 'a/b/c' }],
      [githubPrGetImplementation, { repo: 'a/b', number: 0 }],
      [githubReleaseListImplementation, { repo: '' }],
      [githubRepoInfoImplementation, {}],
      [githubPrCommentImplementation, { repo: 'a/b', number: 1, body: '' }],
      [githubPrCommentImplementation, { repo: 'a/b', number: 1, body: 'x'.repeat(2001) }],
    ] as const;
    for (const [impl, input] of bad) {
      const { output } = await impl.execute({ action: act(impl.toolId, input), context: ctx }) as any;
      expect(output.ok).toBe(false);
    }
  });
});
