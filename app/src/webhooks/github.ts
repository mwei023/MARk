/**
 * GitHub Webhook Handler: Receives GitHub events and converts them to internal events.
 * Integrates with Express for webhook receiver.
 */

import { Request, Response } from 'express';
import { EventBus } from '../core/event-bus';
import { Event, GitHubWorkflowFailedEvent } from '../core/events';

export class GitHubWebhookHandler {
  constructor(private eventBus: EventBus) {}

  /**
   * Express middleware to handle GitHub webhooks
   */
  handler() {
    return async (req: Request, res: Response) => {
      // GitHub sends event type in header
      const eventType = req.headers['x-github-event'] as string;
      const signature = req.headers['x-hub-signature-256'] as string;

      // In production: verify signature
      // const isValid = this.verifyGitHubSignature(req.body, signature);
      // if (!isValid) return res.status(401).send('Unauthorized');

      const payload = req.body;

      console.log(`[GitHub Webhook] Received ${eventType} event`);

      try {
        const internalEvents = this.parseGitHubEvent(eventType, payload);
        
        for (const event of internalEvents) {
          await this.eventBus.emit(event);
        }

        res.status(200).json({ status: 'received' });
      } catch (error) {
        console.error('[GitHub Webhook] Parse error:', error);
        res.status(400).json({ error: 'Invalid payload' });
      }
    };
  }

  private parseGitHubEvent(eventType: string, payload: any): Event[] {
    switch (eventType) {
      case 'push':
        return this.parsePushEvent(payload);

      case 'pull_request':
        return this.parsePullRequestEvent(payload);

      case 'workflow_run':
        return this.parseWorkflowRunEvent(payload);

      case 'deployment_status':
        return this.parseDeploymentStatusEvent(payload);

      case 'issues':
        return this.parseIssueEvent(payload);

      default:
        console.log(`[GitHub Webhook] Unhandled event type: ${eventType}`);
        return [];
    }
  }

  private parsePushEvent(payload: any): Event[] {
    return [{
      id: `GH-PUSH-${payload.repository.id}-${Date.now()}`,
      timestamp: new Date(),
      source: 'github',
      type: 'github.push',
      severity: 'info',
      correlationId: payload.repository.full_name,
      data: {
        repository: payload.repository.full_name,
        branch: payload.ref.split('/').pop(),
        commit: payload.head_commit?.id,
        author: payload.head_commit?.author?.name,
        message: payload.head_commit?.message,
      },
    }];
  }

  private parsePullRequestEvent(payload: any): Event[] {
    const action = payload.action;
    const eventType = 
      action === 'opened' ? 'github.pull_request.opened' :
      action === 'closed' && payload.pull_request.merged ? 'github.pull_request.merged' :
      'github.pull_request.opened'; // Default

    return [{
      id: `GH-PR-${payload.pull_request.id}-${Date.now()}`,
      timestamp: new Date(),
      source: 'github',
      type: eventType,
      severity: 'info',
      correlationId: payload.repository.full_name,
      data: {
        repository: payload.repository.full_name,
        prNumber: payload.pull_request.number,
        title: payload.pull_request.title,
        author: payload.pull_request.user.login,
        branch: payload.pull_request.head.ref,
      },
    }];
  }

  private parseWorkflowRunEvent(payload: any): Event[] {
    const conclusion = payload.workflow_run.conclusion;
    
    // Only care about failures and completions
    if (conclusion === 'failure' || conclusion === 'timed_out') {
      const event: GitHubWorkflowFailedEvent = {
        id: `GH-WORKFLOW-${payload.workflow_run.id}-${Date.now()}`,
        timestamp: new Date(),
        source: 'github',
        type: 'github.workflow.failed',
        severity: 'warning',
        correlationId: payload.repository.full_name,
        data: {
          repository: payload.repository.full_name,
          workflowName: payload.workflow.name,
          commit: payload.workflow_run.head_sha,
          branch: payload.workflow_run.head_branch,
          runId: payload.workflow_run.id,
          conclusion,
          jobsUrl: payload.workflow_run.jobs_url,
          logsUrl: payload.workflow_run.html_url,
        },
      };
      
      return [event];
    }

    if (conclusion === 'success') {
      return [{
        id: `GH-WORKFLOW-${payload.workflow_run.id}-${Date.now()}`,
        timestamp: new Date(),
        source: 'github',
        type: 'github.workflow.completed',
        severity: 'info',
        correlationId: payload.repository.full_name,
        data: {
          repository: payload.repository.full_name,
          workflowName: payload.workflow.name,
          commit: payload.workflow_run.head_sha,
          branch: payload.workflow_run.head_branch,
          runId: payload.workflow_run.id,
        },
      }];
    }

    return [];
  }

  private parseDeploymentStatusEvent(payload: any): Event[] {
    const state = payload.deployment_status.state;

    if (state === 'failure') {
      return [{
        id: `GH-DEPLOY-${payload.deployment.id}-${Date.now()}`,
        timestamp: new Date(),
        source: 'github',
        type: 'github.deployment.failed',
        severity: 'critical',
        correlationId: payload.repository.full_name,
        data: {
          repository: payload.repository.full_name,
          environment: payload.deployment.environment,
          commit: payload.deployment.sha,
          deploymentId: payload.deployment.id,
          reason: payload.deployment_status.description,
        },
      }];
    }

    if (state === 'success') {
      return [{
        id: `GH-DEPLOY-${payload.deployment.id}-${Date.now()}`,
        timestamp: new Date(),
        source: 'github',
        type: 'github.deployment.succeeded',
        severity: 'info',
        correlationId: payload.repository.full_name,
        data: {
          repository: payload.repository.full_name,
          environment: payload.deployment.environment,
          commit: payload.deployment.sha,
          deploymentId: payload.deployment.id,
        },
      }];
    }

    return [];
  }

  private parseIssueEvent(payload: any): Event[] {
    if (payload.action === 'opened') {
      return [{
        id: `GH-ISSUE-${payload.issue.id}-${Date.now()}`,
        timestamp: new Date(),
        source: 'github',
        type: 'github.issue.opened',
        severity: 'info',
        correlationId: payload.repository.full_name,
        data: {
          repository: payload.repository.full_name,
          issueNumber: payload.issue.number,
          title: payload.issue.title,
          author: payload.issue.user.login,
          labels: payload.issue.labels?.map((l: any) => l.name),
        },
      }];
    }

    return [];
  }

  private verifyGitHubSignature(body: any, signature: string): boolean {
    // TODO: Implement HMAC verification with webhook secret
    // For now: accept all
    return true;
  }
}
