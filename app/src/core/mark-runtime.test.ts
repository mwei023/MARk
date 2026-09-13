import assert from 'node:assert/strict';
import { AgentRuntime } from './agent-runtime';
import { EventBus } from './event-bus';
import { Gateway } from './gateway';
import { MarkRuntime, Reasoner } from './mark-runtime';
import { CapabilityRegistry } from '../runtime/capabilities/registry';
import { GitAgent } from '../agents/git-agent';
import { repositoryRegistry } from '../repositories/registry';
import { GitHubWebhookHandler } from '../webhooks/github';
import { incidentStore } from './incident';

const registerTestRepositories = () => {
  repositoryRegistry.register({
    id: 'mwei023/MARk',
    provider: 'github',
    owner: 'mwei023',
    name: 'MARk',
    fullName: 'mwei023/MARk',
    localPath: '/home/mwei/jarvis-core',
    defaultBranch: 'main',
    enabled: true,
    source: 'config',
  });

  repositoryRegistry.register({
    id: 'mwei023/park-guardian-dashboard',
    provider: 'github',
    owner: 'mwei023',
    name: 'park-guardian-dashboard',
    fullName: 'mwei023/park-guardian-dashboard',
    localPath: '/home/mwei/park-guardian-dashboard',
    defaultBranch: 'main',
    enabled: true,
    source: 'config',
  });
};

const run = async (): Promise<void> => {
  registerTestRepositories();

  const repoOne = repositoryRegistry.resolve('mwei023/MARk');
  const repoTwo = repositoryRegistry.resolve('/home/mwei/park-guardian-dashboard');
  assert.equal(repoOne?.fullName, 'mwei023/MARk');
  assert.equal(repoOne?.localPath, '/home/mwei/jarvis-core');
  assert.equal(repoTwo?.fullName, 'mwei023/park-guardian-dashboard');
  assert.equal(repoTwo?.localPath, '/home/mwei/park-guardian-dashboard');

  const bus = new EventBus();
  const handler = new GitHubWebhookHandler(bus);
  const workflowOne = (handler as any).parseGitHubEvent('workflow_run', {
    repository: { id: 1, full_name: 'mwei023/MARk' },
    workflow: { name: 'test-workflow' },
    workflow_run: {
      id: 101,
      conclusion: 'failure',
      head_sha: 'abc123',
      head_branch: 'main',
      jobs_url: 'https://example.com/jobs/101',
      html_url: 'https://example.com/workflows/101',
    },
  });
  const workflowTwo = (handler as any).parseGitHubEvent('workflow_run', {
    repository: { id: 2, full_name: 'mwei023/park-guardian-dashboard' },
    workflow: { name: 'deploy' },
    workflow_run: {
      id: 202,
      conclusion: 'timed_out',
      head_sha: 'def456',
      head_branch: 'main',
      jobs_url: 'https://example.com/jobs/202',
      html_url: 'https://example.com/workflows/202',
    },
  });

  assert.equal(workflowOne[0].data.repository, 'mwei023/MARk');
  assert.equal(workflowTwo[0].data.repository, 'mwei023/park-guardian-dashboard');

  const agents = new AgentRuntime();
  agents.registerAgent(new GitAgent());
  const capabilities = new CapabilityRegistry();
  const reasoner: Reasoner = {
    respond: async (input) => `reasoned: ${input}`,
  };
  const runtime = new MarkRuntime({ eventBus: bus, gateway: new Gateway(), agents, capabilities, reasoner });

  const local = await runtime.executeCommand('what time is it?', 'test-user', 'cli');
  assert.equal(local.route, 'capability');
  assert.match(local.response, /It's/);

  const files = await runtime.executeCommand('show my files', 'test-user', 'cli');
  assert.equal(files.route, 'capability');

  const displayedFiles = await runtime.executeCommand('display my files', 'test-user', 'cli');
  assert.equal(displayedFiles.route, 'capability');

  const directoryFiles = await runtime.executeCommand(
    'list the files in my directory',
    'test-user',
    'cli',
  );
  assert.equal(directoryFiles.route, 'capability');

  const folder = await runtime.executeCommand('open the folder', 'test-user', 'cli');
  assert.equal(folder.route, 'capability');

  const cpu = await runtime.executeCommand('check my CPU usage', 'test-user', 'cli');
  assert.equal(cpu.route, 'capability');

  const disk = await runtime.executeCommand('check disk space', 'test-user', 'cli');
  assert.equal(disk.route, 'capability');

  const agent = await runtime.executeCommand('git status', 'test-user', 'cli');
  assert.equal(agent.route, 'agent');
  assert.match(agent.response, /^GitHub Agent:/);

  const reasoning = await runtime.executeCommand('help me understand neural networks', 'test-user', 'cli');
  assert.deepEqual(reasoning.route, 'reasoning');
  assert.equal(reasoning.response, 'reasoned: help me understand neural networks');

  const general = await runtime.executeCommand('who is the president of Kenya?', 'test-user', 'cli');
  assert.deepEqual(general.route, 'reasoning');
  assert.match(general.response, /reasoned: who is the president of Kenya\?/);

  const capturedIncidents: Array<{ context: { repository?: string; localPath?: string } }> = [];
  const originalCreateIncident = incidentStore.createIncident.bind(incidentStore);
  const originalAddAction = incidentStore.addAction.bind(incidentStore);
  const originalUpdateStatus = incidentStore.updateStatus.bind(incidentStore);
  const originalResolveIncident = incidentStore.resolveIncident.bind(incidentStore);

  try {
    (incidentStore as any).createIncident = async (input: any) => {
      capturedIncidents.push(input);
      return { id: 'INC-TEST', ...input, actions: [] };
    };
    (incidentStore as any).addAction = async () => {};
    (incidentStore as any).updateStatus = async () => {};
    (incidentStore as any).resolveIncident = async () => {};

    const gitAgent = new GitAgent();
    (gitAgent as any).executeTool = async (toolName: string) => ({
      success: true,
      action: { agent: 'git-agent', action: toolName, tool: toolName, result: 'success', details: 'ok' },
      result: toolName === 'fetch_logs' ? 'Build failed: npm err' : 'ok',
    });

    await gitAgent.handle(workflowOne[0]);
    await gitAgent.handle(workflowTwo[0]);

    assert.equal(capturedIncidents[0].context.repository, 'mwei023/MARk');
    assert.equal(capturedIncidents[0].context.localPath, '/home/mwei/jarvis-core');
    assert.equal(capturedIncidents[1].context.repository, 'mwei023/park-guardian-dashboard');
    assert.equal(capturedIncidents[1].context.localPath, '/home/mwei/park-guardian-dashboard');
  } finally {
    (incidentStore as any).createIncident = originalCreateIncident;
    (incidentStore as any).addAction = originalAddAction;
    (incidentStore as any).updateStatus = originalUpdateStatus;
    (incidentStore as any).resolveIncident = originalResolveIncident;
  }

  assert.equal(bus.getRecentEvents('user.command.received', 10).length, 10);
  assert.equal(bus.getRecentEvents('agent.action.taken', 10).length, 10);
  console.log(
    'MARK runtime routes local time, files, system metrics, specialist agents, general knowledge, webhook repo routing, and multi-repo incident association.',
  );
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
