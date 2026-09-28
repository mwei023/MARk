/**
 * Gateway: Intent classifier and event router.
 * Determines if an event needs LLM reasoning or can be handled deterministically.
 */

import { Event, EventType } from './events';
import { routeLocally } from '../runtime/router';
import { SystemAgent } from '../agents/system-agent';

/**
 * Classifies intent, not payload: quoted `field: "value"` segments are
 * stripped before keyword matching so embedded content (HTML, logs, file
 * text) can never hijack routing. Observed live: a write goal carrying
 * `free` output routed to the memory capability instead of the kernel.
 */
function stripQuoted(command: string): string {
  // Escape-aware: payloads arrive JSON-quoted (\" inside), and a naive
  // "[^"]*" stops at the first escaped quote, leaking payload shards that
  // hijack classification. Observed live: dashboard HTML mentioning disk
  // routed a file write to df. (?:[^"\\]|\\.) consumes escapes correctly.
  return command
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

export { stripQuoted };

/**
 * Explicit kernel-tool addressing: `field: value` syntax unique to kernel
 * tools (repoPath:) or a verbatim tool id (repo.index, sys.exec, ...).
 * Either means the user addresses a tool, not an agent. Observed live:
 * deploy orders died in git-agent, sys.exec died on the word "status".
 */
export function isExplicitToolCall(command: string): boolean {
  if (/\brepoPath\s*:/i.test(command)) return true;
  // A bare tool-id mention ("repo.index builds...") is documentation, not
  // addressing. It counts only beside an action verb ("execute sys.exec").
  // Observed live: a draft goal describing tools bypassed to nowhere.
  return /\b(execute|run|call|open|write|commit|push|create|index|search|perceive|draft|compose)\b/i.test(command) &&
    /\b(repo|git|gh|sys|world|ops|browser|fs|desktop|media|incident)\.[\w$.-]+/i.test(command);
}
export function isContentRequest(command: string): boolean {
  // None of the specialist agents draft content — they answer status
  // questions — so these skip agent routing entirely (reasoning still tries
  // the kernel first for explicit file ops).
  return /\b(draft|compose|autobiography|README|homepage|landing page|blog( post)?|poem|essay)\b/i.test(command);
}

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

      // Edge obstacle: physical ops triage by DevOps agent
      case 'edge.obstacle':
        return {
          path: 'agent',
          agent: 'devops-agent',
          needsLLM: false,
          priority: 'high',
          reasoning: 'Obstacle reported by edge node. Stop-first triage, then reroute.',
        };

      // Edge low battery: physical ops triage by DevOps agent
      case 'edge.low_batt':
        return {
          path: 'agent',
          agent: 'devops-agent',
          needsLLM: false,
          priority: event.severity === 'critical' ? 'critical' : 'high',
          reasoning: 'Battery low on edge node. Return-to-charge triage.',
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

      // Code repair: owned by the coding agent (LLM edits + verify-or-revert)
      case 'code.repair.requested':
        return {
          path: 'agent',
          agent: 'code-agent',
          needsLLM: true,
          priority: 'normal',
          reasoning: 'Code repair request. Coding agent proposes minimal edits with verification.',
        };

      // Screen task: owned by the computer-use agent (see + act + verify)
      case 'screen.task.requested':
        return {
          path: 'agent',
          agent: 'screen-agent',
          needsLLM: true,
          priority: 'normal',
          reasoning: 'Screen task. Computer-use agent observes, reasons, acts, and verifies.',
        };

      // Web research: owned by the web agent (search + read)
      case 'web.search.requested':
        return {
          path: 'agent',
          agent: 'web-agent',
          needsLLM: false,
          priority: 'normal',
          reasoning: 'Web research request. Web agent searches and reads.',
        };

      // Deep research: owned by the research agent (exhaustive loop)
      case 'research.requested':
        return {
          path: 'agent',
          agent: 'research-agent',
          needsLLM: false,
          priority: 'normal',
          reasoning: 'Deep research request. Research agent runs the exhaustive loop.',
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

      // Edge presence signals: bus-visible, no action needed
      case 'edge.wake':
      case 'edge.node.online':
        return {
          path: 'deterministic',
          needsLLM: false,
          priority: 'low',
          reasoning: 'Edge presence signal. Logged on the bus, no triage.',
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

    const cmd = stripQuoted(command);

    // Agent intent patterns use whole-word matching only. Substring
    // `includes()` misroutes ("legitimate" -> git, "latest" -> test,
    // "somehow" -> how). Word boundaries keep specialist routing precise;
    // anything ambiguous falls through to kernel / reasoning.
    const GIT_RE = /\b(git|branch|branches|commit|commits|merge|rebase|pull request|status|heads?\s?-?\s?up)\b/i;
    const DEVOPS_RE = /\b(deploy|deployment|deployments|rollback|restart|docker|container|containers|kubernetes|k8s|health)\b/i;
    const CICD_RE = /\b(pipeline|pipelines|build|builds|test|tests|testing|lint)\b/i;
    const WEB_RE = /\b(google|browse|browsing|look\s?up|search the web|research)\b/i;
    const DEEP_RESEARCH_RE = /\b(deep research|deep dive|thorough(ly)? research|exhaust(ive|ively)|investigate thoroughly|literature review|state of the art|sota|survey the field|map the field)\b/i;
    const REASONING_RE = /\b(debug|why|how|investigate|investigation|explain)\b/i;

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

    if (routeLocally(stripQuoted(command))) {
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

    // Explicit kernel-tool calls bypass agent heuristics (see
    // isExplicitToolCall): the user addresses a tool, not an agent.
    // needsLLM stays true so reasoning remains the fallback when the kernel
    // declines (creative guard) or cannot bind — otherwise the order strands
    // as unroutable. Observed live: a draft describing tools bypassed, the
    // kernel correctly refused, and nothing else could claim it.
    if (isExplicitToolCall(cmd)) {
      return {
        path: 'reasoning',
        needsLLM: true,
        priority: 'normal',
        reasoning: 'Explicit kernel tool call. Kernel resolves and binds.',
      };
    }

    // Content-creation goes straight to reasoning, past every agent.
    if (isContentRequest(cmd)) {
      return {
        path: 'reasoning',
        needsLLM: true,
        priority: 'normal',
        reasoning: 'Content-creation request. Reasoning drafts; kernel handles explicit file ops.',
      };
    }

    // Machine-inspection commands — checked before git/devops/cicd so
    // "is postgres running" and "list running services" reach the
    // read-only SystemAgent, not git-agent (status) or devops-agent.
    // Deterministic local intents (disk/memory/cpu/time) and MARK's own
    // "system status" config answer already returned above; this owns
    // what they miss. Single source of truth: SystemAgent.isSystemCommand.
    if (SystemAgent.isSystemCommand(cmd)) {
      return {
        path: 'agent',
        agent: 'system-agent',
        needsLLM: false,
        priority: 'normal',
        reasoning: 'System inspection operation',
      };
    }

    // Git commands
    if (GIT_RE.test(cmd)) {
      return {
        path: 'agent',
        agent: 'git-agent',
        needsLLM: false,
        priority: 'normal',
        reasoning: 'Git operation',
      };
    }

    // Deployment/DevOps commands
    if (DEVOPS_RE.test(cmd)) {
      return {
        path: 'agent',
        agent: 'devops-agent',
        needsLLM: false,
        priority: 'high',
        reasoning: 'DevOps operation',
      };
    }

    // Code repair commands — checked before CI/CD so "repair the lint
    // errors" reaches the repairer, not the pipeline runner. Observed in
    // eval: repair orders misrouted to cicd-agent on the word "lint".
    if (/\b(repair|fix(ing|ed|es)?)\b/i.test(cmd)) {
      return {
        path: 'agent',
        agent: 'code-agent',
        needsLLM: false,
        priority: 'normal',
        reasoning: 'Code repair operation',
      };
    }

    // CI/CD commands
    if (CICD_RE.test(cmd)) {
      return {
        path: 'agent',
        agent: 'cicd-agent',
        needsLLM: false,
        priority: 'normal',
        reasoning: 'CI/CD operation',
      };
    }

    // Deep research commands — checked before the generic web pattern so
    // "deep research X" reaches the research agent, not the web agent.
    if (DEEP_RESEARCH_RE.test(cmd)) {
      return {
        path: 'agent',
        agent: 'research-agent',
        needsLLM: false,
        priority: 'normal',
        reasoning: 'Deep research operation',
      };
    }

    // Web research commands
    if (WEB_RE.test(cmd)) {
      return {
        path: 'agent',
        agent: 'web-agent',
        needsLLM: false,
        priority: 'normal',
        reasoning: 'Web research operation',
      };
    }

    // Complex reasoning needed
    if (REASONING_RE.test(cmd) || /\bfigure out\b/i.test(cmd)) {
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
