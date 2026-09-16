/**
 * Gateway: Intent classifier and event router.
 * Determines if an event needs LLM reasoning or can be handled deterministically.
 */

import { Event, EventType } from './events';
import { routeLocally } from '../runtime/router';

export type RoutingPath = 'deterministic' | 'agent' | 'reasoning' | 'escalate';

export interface RoutingDecision {
  path: RoutingPath;
  agent?: string; // Which agent should handle this
  needsLLM: boolean; // Should we invoke the LLM?
  priority: 'low' | 'normal' | 'high' | 'critical';
  reasoning: string; // Why this decision
}

/**
 * Gateway: Routes events to appropriate handlers
 */
export class Gateway {
  /**
   * Classify an event and determine how to handle it
   */
  classify(event: Event): RoutingDecision {
    return this.routeByType(event.type, event);
  }

  private routeByType(type: EventType, event: Event): RoutingDecision {
    switch (type) {
      // GitHub Workflow Failed: Deterministic investigation by GitAgent
      case 'github.workflow.failed':
        return {
          path: 'agent',
          agent: 'git-agent',
          needsLLM: false, // Try heuristics first
          priority: event.severity === 'critical' ? 'high' : 'normal',
          reasoning: 'Known patterns: lint, type errors, missing deps. Try heuristic fixes first.',
        };

      // GitHub Deployment Failed: DevOps agent investigates + considers rollback
      case 'github.deployment.failed':
        return {
          path: 'agent',
          agent: 'devops-agent',
          needsLLM: false,
          priority: 'critical',
          reasoning: 'Production issue. Check health, propose rollback if safe.',
        };

      // Docker Health Check Failed: DevOps agent handles
      case 'docker.container.health_status.unhealthy':
        return {
          path: 'agent',
          agent: 'devops-agent',
          needsLLM: false,
          priority: 'high',
          reasoning: 'Service unhealthy. Gather diagnostics, attempt restart.',
        };

      // CI Test Failed: Deterministic patterns first
      case 'ci.test.failed':
        return {
          path: 'agent',
          agent: 'git-agent',
          needsLLM: false,
          priority: 'normal',
          reasoning: 'Test failure. Check logs for known patterns.',
        };

      // User Command: Route based on content
      case 'user.command.received':
        return this.routeUserCommand(event);

      // Approval responses
      case 'user.approval.granted':
      case 'user.approval.denied':
        return {
          path: 'deterministic',
          needsLLM: false,
          priority: 'high',
          reasoning: 'Approval response. Resume pending operation.',
        };

      // Everything else: escalate for manual review
      default:
        return {
          path: 'escalate',
          needsLLM: false,
          priority: 'normal',
          reasoning: 'Unknown event type. Needs manual review.',
        };
    }
  }

  private routeUserCommand(event: Event): RoutingDecision {
    const command = (event.data as Record<string, any>).command;
    if (!command || typeof command !== 'string') {
      return {
        path: 'escalate',
        needsLLM: false,
        priority: 'normal',
        reasoning: 'Empty command',
      };
    }

    const cmd = command.toLowerCase();

    if (
      /\b(what llm|which llm|what model|which model|llm provider|ai provider|mark status|system status|how are you configured|configuration)\b/i.test(
        command,
      )
    ) {
      return {
        path: 'deterministic',
        needsLLM: false,
        priority: 'normal',
        reasoning: 'MARK can answer its own configuration locally.',
      };
    }

    if (routeLocally(command)) {
      // Storage-hog questions need measured directory sizes, not a df
      // snapshot. Route them past the fast local path so the kernel answers
      // from data. One concept-level rule — not one per situation.
      if (/\b(eat|eating|eats|hog|hogs|hogging|largest|biggest|filling|using up)\b/i.test(command)) {
        return {
          path: 'reasoning',
          needsLLM: true,
          priority: 'normal',
          reasoning: 'Storage-hog question. Prefer kernel measurement over a df snapshot.',
        };
      }
      return {
        path: 'deterministic',
        needsLLM: false,
        priority: 'normal',
        reasoning: 'A local host capability can answer this request.',
      };
    }

    // Git commands
    if (cmd.includes('git') || cmd.includes('branch') || cmd.includes('commit')) {
      return {
        path: 'agent',
        agent: 'git-agent',
        needsLLM: false,
        priority: 'normal',
        reasoning: 'Git operation',
      };
    }

    // Deployment/DevOps commands
    if (cmd.includes('deploy') || cmd.includes('rollback') || cmd.includes('restart') || cmd.includes('docker')) {
      return {
        path: 'agent',
        agent: 'devops-agent',
        needsLLM: false,
        priority: 'high',
        reasoning: 'DevOps operation',
      };
    }

    // CI/CD commands
    if (cmd.includes('pipeline') || cmd.includes('build') || cmd.includes('test')) {
      return {
        path: 'agent',
        agent: 'cicd-agent',
        needsLLM: false,
        priority: 'normal',
        reasoning: 'CI/CD operation',
      };
    }

    // Complex reasoning needed
    if (
      cmd.includes('debug') ||
      cmd.includes('why') ||
      cmd.includes('how') ||
      cmd.includes('figure out') ||
      cmd.includes('investigate')
    ) {
      return {
        path: 'reasoning',
        needsLLM: true,
        priority: 'normal',
        reasoning: 'Needs abstract analysis',
      };
    }

    // General conversation and knowledge requests belong to the reasoning path.
    return {
      path: 'reasoning',
      needsLLM: true,
      priority: 'normal',
      reasoning: 'No deterministic capability or specialist agent matches the request.',
    };
  }
}

export const gateway = new Gateway();
