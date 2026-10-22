import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CICDAgent } from './cicd-agent.js';

const mk = (command: string) =>
  ({
    id: 'e',
    timestamp: new Date(),
    source: 'user_command',
    type: 'user.command.received',
    severity: 'info',
    data: { command },
  }) as any;

function scratchGoRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mark-cicd-verify-'));
  writeFileSync(join(dir, 'go.mod'), 'module verifyfixture\n\ngo 1.21\n');
  writeFileSync(join(dir, 'main.go'), 'package main\n\nfunc main() {}\n');
  return dir;
}

describe('verify order', () => {
  it('still refuses non-verify requests (triage only, approval-gated)', async () => {
    const agent = new CICDAgent();
    const res = await agent.handleCommand(mk('the pipeline is red, investigate'), {} as any);
    expect(res).toMatch(/triage only/);
  });

  it('asks which repo when none is named', async () => {
    const agent = new CICDAgent();
    const res = await agent.handleCommand(mk('verify the build'), {} as any);
    expect(res).toMatch(/Which repository\?/);
  });

  it('passes a clean go repo', async () => {
    const agent = new CICDAgent();
    const res = await agent.handleCommand(mk(`verify the build in ${scratchGoRepo()}`), {} as any);
    expect(res).toMatch(/PASS go build/);
    expect(res).toMatch(/All checks passed/);
  }, 30000);

  it('fails a broken go repo with an excerpt, not a dump', async () => {
    const dir = scratchGoRepo();
    appendFileSync(join(dir, 'main.go'), 'this is not go\n');
    const agent = new CICDAgent();
    const res = await agent.handleCommand(mk(`verify the build in ${dir}`), {} as any);
    expect(res).toMatch(/FAIL go build/);
    expect(res).toMatch(/1 check\(s\) failed/);
    expect(res.length).toBeLessThan(2000);
  }, 30000);

  it('reports repos with no known checks honestly', async () => {
    const agent = new CICDAgent();
    const res = await agent.handleCommand(mk(`verify the build in ${mkdtempSync(join(tmpdir(), 'mark-cicd-empty-'))}`), {} as any);
    expect(res).toMatch(/No known build checks/);
  });
});
