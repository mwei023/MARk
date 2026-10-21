/**
 * Gateway: Intent classifier and event router.
 * Determines if an event needs LLM reasoning or can be handled deterministically.
 */

import { Event, EventType } from './events';
import { routeLocally } from '../runtime/router';
import { SystemAgent } from '../agents/system-agent';
import { hasProjectWord, findProjectDirs } from './project-index';
import { classifyRoutingIntent } from './routing-classifier';

/**
 * Classifies intent, not payload: quoted `field: "value"` segments are
 * stripped before keyword matching so embedded content (HTML, logs, file
 * text) can never hijack routing. Observed live: a write goal carrying
 * `free` output routed to the memory capability instead of the kernel.
 *
 * Also strips unquoted `field: value` pairs used in kernel tool syntax
 * (e.g. `kb.note_write with title: test`) so payload words like "test"
 * or "build" don't hijack the CICD/git classifier. Observed live:
 * `kb.note_write with title: test` routed to cicd-agent on the word "test".
 */
function stripQuoted(command: string): string {
  // Escape-aware: payloads arrive JSON-quoted (\" inside), and a naive
  // "[^"]*" stops at the first escaped quote, leaking payload shards that
  // hijack classification. Observed live: dashboard HTML mentioning disk
  // routed a file write to df. (?:[^"\\]|\\.) consumes escapes correctly.
  return command
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    // Strip unquoted kernel field: value pairs (word after colon up to next
    // keyword boundary). Matches `title: test`, `content: hello world`,
    // `path: /home/mwei`. The replace target is the value token only so
    // the field name itself stays (it's part of tool addressing, not payload).
    .replace(/\b(title|content|body|message|text|name|query|filter|path|dest|pattern|branch|commit|repo|skill|subject|to|from|cc)\s*:\s*\S+/gi, (_m, field) => `${field}: ""`);
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
  // Domain list covers all registered kernel provider namespaces — missing
  // ones (kb, lsp, email, assistant, skill) caused tool calls to fall
  // through to agent routing. Observed live: kb.note_write hit cicd-agent.
  //
  // Two forms of explicit addressing:
  // 1. Standalone verb + tool id: "write kb.note_write ..."
  // 2. Tool id whose suffix IS the action: "kb.note_write with ..."
  //    (verb embedded in tool name — no standalone verb needed)
  const TOOL_RE = /\b(repo|git|gh|sys|world|ops|browser|fs|desktop|media|incident|kb|lsp|email|assistant|skill|investigate|screen|net|system)\.[\w$.-]+/i;
  const VERB_RE = /\b(execute|run|call|open|write|commit|push|create|index|search|perceive|draft|compose)\b/i;
  const ACTION_IN_TOOL_RE = /\b(repo|git|gh|sys|world|ops|browser|fs|desktop|media|incident|kb|lsp|email|assistant|skill|investigate|screen|net|system)\.\w*(write|read|send|create|install|exec|search|list|deploy|push|commit|open|close|find|extract|check)\b/i;

  if (TOOL_RE.test(command) && (VERB_RE.test(command) || ACTION_IN_TOOL_RE.test(command))) return true;
  return false;
}
export function isContentRequest(command: string): boolean {  // None of the specialist agents draft content — they answer status
  // questions — so these skip agent routing entirely (reasoning still tries
  // the kernel first for explicit file ops).
  return /\b(draft|compose|autobiography|README|homepage|landing page|blog( post)?|poem|essay)\b/i.test(command);
}

function isDirectoryListingQuestion(command: string): boolean {
  return /\b(?:what|show|list|display)\s+(?:is\s+)?(?:in\s+)?(?:the\s+)?(?:home|downloads?|documents?|library|desktop|tmp|var|work|src)(?:\s+(?:directory|folder|path))?\b/i.test(command)
    || /\b(?:home|downloads?|documents?|library|desktop|tmp|var|work|src)\s+(?:directory|folder|path)\b/i.test(command);
}

function isServiceActionCommand(command: string): boolean {
  return /\b(?:start|restart|stop|reload|redeploy|recover|scale|check|inspect|show|monitor|diagnose)\b.*\b(?:service|services|pod|pods|deployment|deployments|cluster|kubernetes|k8s|ingress|app|api|server)\b/i.test(command)
    || /\b(?:service|services|pod|pods|deployment|deployments|cluster|kubernetes|k8s|ingress)\b.*\b(?:health|status|uptime|healthy|running)\b/i.test(command)
    || /\b(?:service|pod|cluster|deployment|ingress)\s+(?:health|status|uptime)\b/i.test(command)
    || /\b(?:start|restart|stop|redeploy|recover|scale)\b\s+(?:the\s+)?(?:api|web|app|service|server)\b/i.test(command);
}

/**
 * Project reference: explicit project words, or a command mentioning a
 * known local project directory ("institution OS" vs the operating
 * system). Used to veto the SystemAgent hijack and as the last agent
 * branch. Cached scan — cheap on the hot path.
 */
export function isProjectReference(command: string): boolean {
  if (hasProjectWord(command)) return true;
  return findProjectDirs(command).length > 0;
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

      // Successful workflows close the loop for fixes previously recorded by
      // GitAgent. Route completion events to the same owner so provenance can
      // be matched and ops memory can be marked verified.
      case 'github.workflow.completed':
        return {
          path: 'agent',
          agent: 'git-agent',
          needsLLM: false,
          priority: 'low',
          reasoning: 'Successful workflow. Verify any matching prior fix or rollback outcome.',
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
          priority: 'critical',
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

    // Long-form engineering briefs must never be answered by keyword
    // heuristics. Observed live: a multi-thousand-char Go production-queue
    // spec containing "in-memory implementation" matched routeLocally's
    // /\b(memory|...)\b/ and was answered with a `free` snapshot; without
    // that word, "status" (HTTP status codes) would have routed it to
    // git-agent. Shallow snapshots and single-verb agents only own SHORT
    // commands — a brief with code signals goes to reasoning (LLM/kernel).
    if (
      cmd.length > 400 &&
      (hasProjectWord(cmd) ||
        /\/(tmp|home)\//.test(cmd) ||
        /\.go\b/i.test(cmd) ||
        /\b(repositor|implement|refactor|persistent|idempoten|concurren|goroutine|http api|production-safe|graceful shutdown|retr(y|ies)|lease|database|transactional|observability|job queue|worker)\b/i.test(cmd))
    ) {
      return {
        path: 'reasoning',
        needsLLM: true,
        priority: 'normal',
        reasoning: 'Long-form engineering brief with code signals. Keyword heuristics abstain; needs reasoning/kernel.',
      };
    }

    // Agent intent patterns use whole-word matching only. Substring
    // `includes()` misroutes ("legitimate" -> git, "latest" -> test,
    // "somehow" -> how). Word boundaries keep specialist routing precise;
    // anything ambiguous falls through to kernel / reasoning.
    const GIT_RE = /\b(git|branch|branches|commit|commits|merge|rebase|pull request|status|heads?\s?-?\s?up)\b/i;
    const DEVOPS_RE = /\b(deploy|deployment|deployments|rollback|restart|docker|container|containers|kubernetes|k8s|health)\b/i;
    const CICD_RE = /\b(pipeline|pipelines|build|builds|test|tests|testing|lint)\b/i;
    const WEB_RE = /\b(google|browse|browsing|look\s?up|search the web|research)\b/i;
    // Link checking ("is the linkedin link working", "check on the link").
    // Kept in sync with WebAgent's LINK_CHECK_RE deliberately — the
    // classifier and the agent must agree, or routing promises an agent
    // that declines.
    const LINK_CHECK_RE = /\b(check|checks|verify|verifying|test|testing|is|are)\b.{0,50}\b(links?|urls?)\b/i;
    const LINK_STATUS_RE = /\b(links?|urls?)\b.{0,30}\b(work(ing|s)?|broken|valid|alive|dead|up|down)\b/i;
    const DEEP_RESEARCH_RE = /\b(deep research|deep dive|thorough(ly)? research|exhaust(ive|ively)|investigate thoroughly|literature review|state of the art|sota|survey the field|map the field)\b/i;
    const REASONING_RE = /\b(debug|why|how|investigate|investigation|explain)\b/i;
    const DIRECTORY_LOOKUP_RE = /\b(?:what(?:'s| is)|show|list|display|tell me what|check)\b.{0,50}\b(?:in|inside|within)\b.{0,40}\b(?:the\s+)?(?:home|downloads?|documents?|pictures?|library|folder|directory)\b/i;
    const CONCEPTUAL_EXPLANATION_RE = /\b(?:teach me|please explain|explain(?:\s+(?:what|how|why|this))?|can you explain|show me a simple explanation of|what does .* mean|what is\s+(?:a|an|the|this|that|load balancing|git|docker|kubernetes|devops|linux|api|database|cache|queue|service|microservice)|how (?:does|do|works)|why (?:is|are|do|does)|can you help me(?:\s+(?:learn|understand|plan|with))?)\b/i;
    const SERVICE_OPERATION_RE = /\b(?:service|services|deployment|deployments|container|docker|kubernetes|k8s|pod|cluster|ingress|health|uptime)\b/i;
    const SERVICE_ACTION_RE = /\b(?:check|show|inspect|list|restart|start|stop|scale|redeploy|status|healthy|health|running|uptime)\b/i;

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

    // Handle exploratory directory and conceptual explanation requests before
    // any local or agent heuristics can misclassify them as operational tasks.
    // Directory asks with a REAL local folder are the exception: the local
    // host capability lists them directly (routeLocally binds "downloads
    // folder" → $HOME/Downloads). Observed live: forcing these into reasoning
    // made the LLM answer "I can't see your files" while the capability
    // existed and worked. Only non-folder lookups stay with the LLM.
    if (DIRECTORY_LOOKUP_RE.test(cmd)) {
      if (routeLocally(cmd)?.type === 'files') {
        return {
          path: 'deterministic',
          needsLLM: false,
          priority: 'normal',
          reasoning: 'Directory listing of a known local folder; local capability answers.',
        };
      }
      return {
        path: 'reasoning',
        needsLLM: true,
        priority: 'normal',
        reasoning: 'Information request or directory inspection. No action is implied.',
      };
    }

    // Local metrics (disk/memory/cpu) are deterministic and should answer
    // before SystemAgent, while pure system-status questions like
    // "what is running?" continue to go to SystemAgent.
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

    // Service-health operations (service, deployment, pod, cluster, ingress,
    // readiness) belong to DevOps rather than plain machine inspection.
    if (
      (SERVICE_OPERATION_RE.test(cmd) || /\b(?:restart|start|stop|redeploy|scale|recover|deploy)\b/i.test(cmd)) &&
      (SERVICE_ACTION_RE.test(cmd) || /\b(?:health|status|ready|readiness|healthy|up|down|running)\b/i.test(cmd)) &&
      !/\b(?:what\s+is\s+running|is\s+\w+\s+running|list\s+running)\b/i.test(cmd) &&
      !/\b(?:learn|explain|what is\s+(?:git|docker|kubernetes)|teach me)\b/i.test(cmd)
    ) {
      return {
        path: 'agent',
        agent: 'devops-agent',
        needsLLM: false,
        priority: 'high',
        reasoning: 'Service health or status investigation.',
      };
    }

    // Machine inspection should win before generic explanation heuristics,
    // so 'what is running?' and 'is postgres running' reach SystemAgent.
    if (SystemAgent.isSystemCommand(cmd) && !isProjectReference(cmd)) {
      return {
        path: 'agent',
        agent: 'system-agent',
        needsLLM: false,
        priority: 'normal',
        reasoning: 'System inspection operation',
      };
    }

    // CI/CD status and health queries are operational checks, not git status.
    // NOTE: bare "check(s)" is NOT a CI artifact word here — "check on X and
    // tell me if its ready" is a project heads-up, not a pipeline probe.
    // CI artifact names (pipeline | build | workflow | ...) only; a bare
    // "check" + "ready" pair routed arbitrary project sentences to CICD
    // (regression pinned in project-routing.unit.test.ts).
    if (
      (/\b(?:pipeline|pipelines|ci|build|builds|workflow|workflows|job|jobs|release gate|release|deployments?)\b/i.test(cmd) &&
        /\b(?:status|health|healthy|pass(?:ing)?|failing|fail(?:ing)?|red|green|ready)\b/i.test(cmd)) ||
      /\b(?:show|check|verify|review)\b.{0,40}\b(?:pipeline|ci|build|workflow|checks?|release gate)\b.{0,30}\b(?:status|health)\b/i.test(cmd)
    ) {
      return {
        path: 'agent',
        agent: 'cicd-agent',
        needsLLM: false,
        priority: 'normal',
        reasoning: 'CI/CD status or health check.',
      };
    }

    // Explicit kernel-tool calls bypass agent heuristics (see
    // isExplicitToolCall): the user addresses a tool, not an agent.
    // needsLLM stays true so reasoning remains the fallback when the kernel
    // declines (creative guard) or cannot bind — otherwise the order strands
    // as unroutable.
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

    // Educational / explanatory requests are chat intents, not operational
    // tasks. They must stay in the reasoning path even when a domain keyword
    // such as git/docker/build/kubernetes appears in the explanation.
    const EXPLANATION_RE = /\b(?:help me\s+(?:learn|understand|know)|teach me|explain(?:\s+(?:what|how|why|this))?|how (?:does|do)|why (?:is|are|do|does)|can you help me(?:\s+(?:learn|understand|plan|with))?|can you explain|show me a simple explanation of|who is)\b/i;
    if (
      EXPLANATION_RE.test(cmd) &&
      !/\b(?:what\s+is\s+running|is\s+\w+\s+running|what\s+is\s+in\s+the\s+.*(?:directory|folder)|what\s+is\s+in\s+.*(?:directory|folder)|check\s+.*(?:status|health)|what\s+is\s+up)\b/i.test(cmd)
    ) {
      return {
        path: 'reasoning',
        needsLLM: true,
        priority: 'normal',
        reasoning: 'Educational or explanatory request. No action is implied.',
      };
    }

    // Handle conceptual explanation requests that are not service status or
    // directory enumeration queries.
    if (CONCEPTUAL_EXPLANATION_RE.test(cmd) && !DIRECTORY_LOOKUP_RE.test(cmd)) {
      return {
        path: 'reasoning',
        needsLLM: true,
        priority: 'normal',
        reasoning: 'Information request. No action is implied.',
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

    // Link checking — before CI/CD so "test the links" verifies links
    // instead of running pipelines. WebAgent extracts URLs from the
    // command or resolves project context (lastRepo / named checkout).
    if (LINK_CHECK_RE.test(cmd) || LINK_STATUS_RE.test(cmd)) {
      return {
        path: 'agent',
        agent: 'web-agent',
        needsLLM: false,
        priority: 'normal',
        reasoning: 'Link check operation',
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

    // Project references — last agent branch, after every specialist verb
    // (so "deploy the project" stays devops). Catches what keywords miss:
    // "institution OS project", "my portfolio", "check on wakulima".
    // GitAgent answers with a repo heads-up (status, checks, incidents,
    // remembered resolutions) or a disambiguation question — never machine
    // facts about the operating system.
    if (isProjectReference(cmd)) {
      return {
        path: 'agent',
        agent: 'git-agent',
        needsLLM: false,
        priority: 'normal',
        reasoning: 'Project reference: repo heads-up, not machine inspection',
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

    // Learned-router assist: DEFAULT OFF. It stays disabled until the NB is
    // retrained on >= 200 real (source:'live') rows via npm run
    // training:retrain AND MARK_TRAINED_ROUTER=on is set explicitly. The
    // classifier itself also refuses any model without live provenance
    // (routing-classifier.loadRoutingModel), so stale synthetic weights
    // cannot serve traffic through either gate.
    if (process.env.MARK_TRAINED_ROUTER === 'on') {
      const trained = classifyRoutingIntent(cmd);
      if (trained && trained.confidence >= 0.7) {
        if (trained.label === 'deterministic') {
          return {
            path: 'deterministic',
            needsLLM: false,
            priority: 'normal',
            reasoning: `Training-backed classification: ${trained.evidence.join(', ') || 'match from learned routing data'}`,
          };
        }
        if (trained.label.startsWith('agent:')) {
          return {
            path: 'agent',
            agent: trained.label.slice('agent:'.length),
            needsLLM: false,
            priority: 'normal',
            reasoning: `Training-backed classification: ${trained.evidence.join(', ') || 'match from learned routing data'}`,
          };
        }
        return {
          path: 'reasoning',
          needsLLM: true,
          priority: 'normal',
          reasoning: `Training-backed classification: ${trained.evidence.join(', ') || 'match from learned routing data'}`,
        };
      }
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
