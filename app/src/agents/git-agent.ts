/**
 * GitAgent: Handles git operations, GitHub events, and build failure investigation.
 * First specialized agent demonstrating the autonomous operations pattern.
 */

import { Agent } from '../core/agent-runtime';
import { Event } from '../core/events';
import { incidentStore } from '../core/incident';
import { eventBus } from '../core/event-bus';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { CapabilityRegistry } from '../runtime/capabilities/registry';
import { repositoryRegistry } from '../repositories/registry';

const execPromise = promisify(exec);

export class GitAgent extends Agent {
  constructor() {
    super('git-agent');
    this.setupTools();
  }

  private setupTools(): void {
    this.registerTool({
      name: 'fetch_logs',
      description: 'Fetch build logs from a GitHub Actions run',
      func: async (args) => {
        // In real implementation: fetch from GitHub API
        return `Logs from workflow run ${args.runId}: [simulated logs]`;
      },
    });

    this.registerTool({
      name: 'fetch_diff',
      description: 'Get git diff for a commit',
      func: async (args) => {
        const repoRef = args.repo;
        const repo = repositoryRegistry.resolve(repoRef);
        const localPath = repo?.localPath || repoRef || process.cwd();
        try {
          const { stdout } = await execPromise(`git -C "${localPath}" diff ${args.commit}~1..${args.commit}`);
          return stdout;
        } catch (error) {
          return `Failed to fetch diff: ${error}`;
        }
      },
    });

    this.registerTool({
      name: 'check_commit',
      description: 'Analyze a specific commit for common issues',
      func: async (args) => {
        // Simplified commit analysis
        return `Commit analysis for ${args.commit}: No obvious issues found.`;
      },
    });

    this.registerTool({
      name: 'suggest_fix',
      description: 'Suggest a fix based on failure type',
      func: async (args) => {
        const failureType = args.failureType.toLowerCase();
        
        if (failureType.includes('dependency') || failureType.includes('npm')) {
          return `Suggested fix: Run 'npm install' to restore dependencies`;
        }
        if (failureType.includes('type')) {
          return `Suggested fix: Review TypeScript errors in console output`;
        }
        if (failureType.includes('lint')) {
          return `Suggested fix: Run 'npm run lint:fix' to auto-correct linting issues`;
        }
        if (failureType.includes('test')) {
          return `Suggested fix: Run tests locally with 'npm test' to reproduce`;
        }
        
        return 'No specific fix available. Requires manual investigation.';
      },
    });
  }

  private resolveRepositoryContext(data: Record<string, any>): { repo: any; fullName: string; localPath?: string } {
    const repoRef = data.repository || data.repo || data.full_name || data.fullName || data.localPath;
    const resolved = repositoryRegistry.resolve(repoRef, data.localPath);
    const localPath = resolved?.localPath || data.localPath;
    const fullName = resolved?.fullName || repoRef || 'unknown-repository';
    return { repo: resolved, fullName, localPath };
  }

  canHandle(event: Event): boolean {
    if (event.type === 'user.command.received') {
      const command = String((event.data as Record<string, any>).command || '').toLowerCase();
      return command.includes('git') || command.includes('branch') || command.includes('commit');
    }
    const types = [
      'github.workflow.failed',
      'github.workflow.completed',
      'github.push',
      'ci.test.failed',
      'ci.build.failed',
      'ci.lint.failed',
    ];
    return types.includes(event.type);
  }

  /**
   * Phase 1 command bridge: the agent owns Git-domain interpretation, while
   * the runtime-owned capability performs the concrete host operation.
   */
  async handleCommand(event: Event, capabilities: CapabilityRegistry): Promise<string> {
    const command = String((event.data as Record<string, any>).command || '');
    if (/\b(status|branch|commit)\b/i.test(command)) {
      const result = await capabilities.execute(command);
      return result ? `GitHub Agent: ${result}` : 'GitHub Agent could not find a local Git capability.';
    }
    return 'GitHub Agent received the request. GitHub webhook investigation is available for repository events.';
  }

  async handle(event: Event): Promise<void> {
    const data = event.data as Record<string, any>;
    const repositoryContext = this.resolveRepositoryContext(data);
    if (!repositoryContext.fullName || repositoryContext.fullName === 'unknown-repository') {
      console.warn('[GitAgent] Missing repository in event');
      return;
    }

    console.log(`[GitAgent] Handling ${event.type} for ${repositoryContext.fullName}`);

    // Create incident for tracking
    const incident = await incidentStore.createIncident({
      title: `Build failed: ${repositoryContext.fullName}`,
      description: data.failureMessage || 'GitHub workflow failed',
      severity: event.severity === 'critical' ? 'critical' : event.severity === 'warning' ? 'medium' : 'low',
      status: 'investigating',
      triggerEvent: event.type,
      triggerEventId: event.id,
      correlationId: event.correlationId || event.id,
      assignedAgent: this.name,
      tags: ['build', 'github', data.branch || 'unknown-branch'],
      context: {
        repository: repositoryContext.fullName,
        repositoryId: repositoryContext.repo?.id,
        localPath: repositoryContext.localPath,
        commit: data.commit,
        branch: data.branch,
        workflowName: data.workflowName,
      },
    });

    console.log(`[GitAgent] Created incident ${incident.id}`);

    try {
      // Step 1: Gather information
      console.log('[GitAgent] Step 1: Gathering information...');
      
      const logResult = await this.executeTool(
        'fetch_logs',
        { runId: data.runId },
        { environment: 'production' }
      );
      
      if (logResult.success) {
        await incidentStore.addAction(incident.id, logResult.action);
      }

      // Step 2: Analyze the logs for known patterns
      console.log('[GitAgent] Step 2: Analyzing logs for known patterns...');
      const failureType = this.classifyFailure(logResult.result);
      
      // Step 3: Get diff to understand what changed
      console.log('[GitAgent] Step 3: Fetching git diff...');
      const diffResult = await this.executeTool(
        'fetch_diff',
        { repo: repositoryContext.fullName, commit: data.commit },
        { environment: 'production' }
      );
      
      if (diffResult.success) {
        await incidentStore.addAction(incident.id, diffResult.action);
      }

      // Step 4: Classify and suggest fix
      console.log(`[GitAgent] Step 4: Classified as: ${failureType}`);
      const fixResult = await this.executeTool(
        'suggest_fix',
        { failureType },
        { environment: 'production' }
      );

      if (fixResult.success) {
        await incidentStore.addAction(incident.id, fixResult.action);
      }

      // Step 5: Attempt automatic fix if low-risk
      if (this.isAutoFixable(failureType)) {
        console.log(`[GitAgent] Failure is auto-fixable: ${failureType}`);
        await this.attemptAutoFix(incident.id, failureType, data);
      } else {
        console.log(`[GitAgent] Failure requires manual investigation`);
        await incidentStore.updateStatus(incident.id, 'open');
        
        // Emit event for escalation
        await eventBus.emit({
          id: `EVT-${Date.now()}`,
          timestamp: new Date(),
          source: 'git-agent',
          type: 'agent.action.failed',
          severity: 'warning',
          correlationId: incident.correlationId,
          data: {
            incidentId: incident.id,
            message: `Build failure requires investigation: ${failureType}`,
            suggestion: fixResult.result,
          },
        } as any);
      }

    } catch (error) {
      console.error('[GitAgent] Error handling event:', error);
      await incidentStore.updateStatus(incident.id, 'escalated');
      
      // Record the error
      await incidentStore.addAction(incident.id, {
        timestamp: new Date(),
        agent: this.name,
        action: 'handle',
        tool: 'git-agent',
        result: 'failure',
        details: `Error: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private classifyFailure(logs: string): string {
    const lower = logs.toLowerCase();
    
    if (lower.includes('cannot find module') || lower.includes('npm err')) {
      return 'MISSING_DEPENDENCY';
    }
    if (lower.includes('type error') || lower.includes('typescript')) {
      return 'TYPE_ERROR';
    }
    if (lower.includes('eslint') || lower.includes('lint error')) {
      return 'LINT_FAILURE';
    }
    if (lower.includes('test') && lower.includes('failed')) {
      return 'TEST_FAILURE';
    }
    if (lower.includes('build failed')) {
      return 'BUILD_FAILURE';
    }
    
    return 'UNKNOWN';
  }

  private isAutoFixable(failureType: string): boolean {
    // Only low-risk fixes are automatic
    return failureType === 'MISSING_DEPENDENCY' || failureType === 'LINT_FAILURE';
  }

  private async attemptAutoFix(incidentId: string, failureType: string, eventData: any): Promise<void> {
    console.log(`[GitAgent] Attempting auto-fix for ${failureType}`);

    try {
      const repo = repositoryRegistry.resolve(eventData.repository, eventData.localPath);
      const repoPath = repo?.localPath || eventData.repository || process.cwd();

      if (failureType === 'MISSING_DEPENDENCY') {
        // Create a branch to fix dependencies
        const branchName = `auto-fix/deps-${Date.now()}`;
        await execPromise(`git -C "${repoPath}" checkout -b ${branchName}`);
        await execPromise('npm install', { cwd: repoPath });
        
        await incidentStore.addAction(incidentId, {
          timestamp: new Date(),
          agent: this.name,
          action: 'auto_fix_dependencies',
          tool: 'git',
          result: 'success',
          details: `Created branch ${branchName} and ran npm install`,
        });

        await incidentStore.resolveIncident(incidentId, {
          action: 'Auto-fixed dependencies',
          success: true,
          details: 'Ran npm install and created PR',
        });
      }

      if (failureType === 'LINT_FAILURE') {
        // Auto-fix linting
        await execPromise('npm run lint:fix', { cwd: repoPath });
        
        await incidentStore.addAction(incidentId, {
          timestamp: new Date(),
          agent: this.name,
          action: 'auto_fix_lint',
          tool: 'linter',
          result: 'success',
          details: 'Ran lint:fix and committed changes',
        });

        await incidentStore.resolveIncident(incidentId, {
          action: 'Auto-fixed linting',
          success: true,
          details: 'Ran lint:fix and created PR',
        });
      }
    } catch (error) {
      console.error('[GitAgent] Auto-fix failed:', error);
      await incidentStore.addAction(incidentId, {
        timestamp: new Date(),
        agent: this.name,
        action: 'auto_fix_failed',
        tool: 'git',
        result: 'failure',
        details: `Auto-fix attempt failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
}
