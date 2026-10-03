// src/cli.ts - Non-interactive MARK CLI for scripting and real actions.
// Usage: npm run cli -- run "restart jarvis-db" | plan "goal" | approve <id> ...
// Env files are loaded centrally in config.ts (before it snapshots process.env).
import { markRuntime } from './core/mark-runtime';
import { likeMeLoop, LikeMeMode } from './core/like-me-loop';
import { incidentStore } from './core/incident';
import { episodeMemory } from './kernel/episode-memory';
import { reliabilityTracker } from './kernel/reliability';
import { config } from './config.js';

interface Flags {
  json: boolean;
  user: string;
  source: 'api' | 'cli' | 'voice';
  mode: LikeMeMode;
  deny: boolean;
  smart: boolean;
  always: boolean;
  root: boolean;
}

function parseArgs(argv: string[]): { command: string; rest: string[]; flags: Flags } {
  const flags: Flags = { json: false, user: config.defaultUser, source: 'cli', mode: 'build', deny: false, smart: false, always: false, root: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') flags.json = true;
    else if (arg === '--deny') flags.deny = true;
    else if (arg === '--always') flags.always = true;
    else if (arg === '--root') flags.root = true;
    else if (arg === '--smart') flags.smart = true;
    else if (arg === '--user' && argv[i + 1]) flags.user = argv[++i];
    else if (arg === '--source' && (argv[i + 1] === 'api' || argv[i + 1] === 'cli' || argv[i + 1] === 'voice')) {
      flags.source = argv[++i] as Flags['source'];
    } else if (arg === '--mode' && (argv[i + 1] === 'plan' || argv[i + 1] === 'build')) {
      flags.mode = argv[++i] as LikeMeMode;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  const [command = '', ...rest] = positional;
  return { command, rest, flags };
}

function out(flags: Flags, value: unknown): void {
  if (flags.json) {
    console.log(JSON.stringify(value, null, 2));
  } else if (typeof value === 'string') {
    console.log(value);
  } else {
    console.log(JSON.stringify(value, null, 2));
  }
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

/** Flush learning writes before exiting so short-lived CLI runs still teach. */
async function done(code: number): Promise<never> {
  try {
    await episodeMemory.flush();
  } catch { /* best effort */ }
  try {
    await reliabilityTracker.flush();
  } catch { /* best effort */ }
  process.exit(code);
}

const HELP = `mark — non-interactive MARK CLI

  run <goal...>              execute a goal via MarkRuntime (capability/agent/kernel/reasoning)
  plan <goal...>             preview a like-me plan (never executes mutating steps)
  execute <goal...>          execute a like-me plan [--mode plan|build]
  approve <id> [--deny] [--always|--root]  approve (or deny); --always = allow always, --root = allow in this project root
  pending                    list pending kernel confirmations
  status                     kernel + incident status
  incidents                  list open incidents
  trust <pattern>            always approve a tool (id or prefix)
  untrust <pattern>          remove standing trust
  trustlist                  show standing trust grants (+ earned suggestions)
  memory <query...>          recall similar past action outcomes (episodic memory)
  reliability                per-tool success stats learned from outcomes

Flags: --json  --user <id>  --source api|cli|voice  --mode plan|build  --deny  --always  --root  --smart
`;

async function main(): Promise<void> {
  const { command, rest, flags } = parseArgs(process.argv.slice(2));

  switch (command) {
    case 'run': {
      const goal = rest.join(' ').trim();
      if (!goal) fail('run needs a goal');
      const result = await markRuntime.executeCommand(goal, flags.user, flags.source);
      if (flags.json) {
        out(flags, result);
      } else {
        out(flags, `[${result.route}] ${result.response}`);
        if (result.trace?.length) out(flags, `  ⎿ ${result.trace.join('\n  ⎿ ')}`);
      }
      await done(result.route === 'unavailable' ? 2 : 0);
      break;
    }
    case 'plan': {
      const goal = rest.join(' ').trim();
      if (!goal) fail('plan needs a goal');
      await likeMeLoop.ensureInit();
      const preview = flags.smart
        ? await likeMeLoop.previewSmart(goal, 'plan')
        : likeMeLoop.preview(goal, 'plan');
      if (flags.smart && !flags.json) {
        out(flags, `plan source: ${(preview as any).planSource ?? 'metadata'}`);
      }
      if (flags.json) {
        out(flags, preview);
      } else {
        out(flags, formatPreview(preview));
      }
      await done(preview.validation.valid ? 0 : 2);
      break;
    }
    case 'execute': {
      const goal = rest.join(' ').trim();
      if (!goal) fail('execute needs a goal');
      const result = await likeMeLoop.execute(goal, { mode: flags.mode, userId: flags.user, source: flags.source, smart: flags.smart });
      if (flags.json) {
        out(flags, result);
      } else {
        out(flags, `${formatPreview(result.preview)}\nexecuted=${result.executed}` +
          (result.report ? ` status=${(result.report as any).status}` : '') +
          `\npending=${result.pendingConfirmations?.length ?? 0} (mark approve <id>)`);
      }
      await done(0);
      break;
    }
    case 'approve':
    case 'deny': {
      const text = rest.join(' ').trim();
      if (!text) fail(`${command} needs a confirmation id`);
      const approved = command === 'approve' && !flags.deny;
      const trust = approved && flags.always ? 'tool' as const : approved && flags.root ? 'root' as const : undefined;
      const verdict = likeMeLoop.resolveApproval(text);
      if (verdict.kind !== 'record') fail('no matching pending confirmation');
      if (!approved) {
        const record = likeMeLoop.approve((verdict as any).record.id, false);
        if (!record) fail('confirmation not found or already decided');
        out(flags, flags.json ? record : `denied ${(record as any).toolId} (${(record as any).id})`);
        break;
      }
      const resumed = await likeMeLoop.approveAndResume((verdict as any).record.id, flags.user, trust ? { trust } : {});
      if (!resumed) fail('confirmation not found or already decided');
      out(flags, flags.json ? resumed : `approved ${(resumed as any).record.toolId} → ${(resumed as any).result.status}` +
        (trust === 'tool' ? ' + trusted always' : trust === 'root' ? ' + trusted in this root' : ''));
      break;
    }
    case 'pending': {
      await likeMeLoop.ensureInit();
      const pending = likeMeLoop.listPending();
      out(flags, flags.json ? pending : pending.length === 0
        ? '(no pending confirmations)'
        : pending.map(p => `${p.id} tool=${p.toolId} input=${JSON.stringify(p.input)}`).join('\n'));
      break;
    }
    case 'status': {
      await markRuntime.initializeKernel();
      const kernel = markRuntime.kernelStatus();
      let incidents: { open: number; critical: number } | { error: string } = { open: -1, critical: -1 };
      try {
        const open = await incidentStore.getOpenIncidents();
        incidents = { open: open.length, critical: open.filter(i => i.severity === 'critical').length };
      } catch (error: any) {
        incidents = { error: error.message };
      }
      out(flags, { kernel, incidents });
      break;
    }
    case 'incidents': {
      try {
        const open = await incidentStore.getOpenIncidents();
        out(flags, flags.json ? open : open.length === 0
          ? '(no open incidents)'
          : open.map(i => `${i.id} [${i.status}/${i.severity}] ${i.title} (${i.assignedAgent})`).join('\n'));
      } catch (error: any) {
        fail(error.message);
      }
      break;
    }
    case 'trust': {
      const pattern = rest.join(' ').trim();
      if (!pattern) fail('trust needs a tool id or prefix');
      likeMeLoop.trust(pattern);
      out(flags, `trusted ${pattern}`);
      break;
    }
    case 'untrust': {
      const pattern = rest.join(' ').trim();
      if (!pattern) fail('untrust needs a tool id or prefix');
      out(flags, likeMeLoop.untrust(pattern) ? `untrusted ${pattern}` : `no trust grant for ${pattern}`);
      break;
    }
    case 'trustlist': {
      const grants = likeMeLoop.listTrusted();
      const suggestions = likeMeLoop.suggestTrust();
      if (flags.json) {
        out(flags, { grants, suggestions });
      } else {
        out(flags, grants.length === 0
          ? '(no standing trust)'
          : grants.map(g => `${g.pattern} (since ${g.grantedAt})`).join('\n'));
        if (suggestions.length > 0) {
          out(flags, 'suggested (earned by behavior):\n' +
            suggestions.map(s => `  ${s.toolId} — ${s.reason}`).join('\n'));
        }
      }
      break;
    }
    case 'memory': {
      const query = rest.join(' ').trim();
      if (!query) fail('memory needs a query');
      const episodes = await episodeMemory.recallSimilar(query, 5);
      out(flags, flags.json ? episodes : episodes.length === 0
        ? '(no similar past outcomes — memory is empty or offline)'
        : episodes.map(e =>
          `${e.toolId} [${e.status}] (${(e.similarity ?? 0).toFixed(2)}) ${e.summary.slice(0, 160)}`,
        ).join('\n'));
      break;
    }
    case 'reliability': {
      await markRuntime.initializeKernel();
      const stats = reliabilityTracker.list().map(s => ({
        tool: s.toolId,
        score: Number(reliabilityTracker.score(s.toolId).toFixed(2)),
        success: s.success,
        failure: s.failure,
        verifyFail: s.verifyFail,
        recovered: s.recoverySuccess,
      }));
      out(flags, flags.json ? stats : stats.length === 0
        ? '(no reliability history yet — every tool scores neutral 0.5)'
        : ['tool score ok/fail verifyFail recovered',
          ...stats.map(s => `${s.tool} ${s.score} ${s.success}/${s.failure} ${s.verifyFail} ${s.recovered}`),
        ].join('\n'));
      break;
    }
    case 'help':
    case '--help':
    case '-h':
    case '':
      out(flags, HELP);
      break;
    default:
      fail(`unknown command: ${command}\n${HELP}`);
  }
  await done(0);
}

function formatPreview(preview: any): string {
  const lines = [`goal: ${preview.goal} (mode=${preview.mode}, valid=${preview.validation.valid})`];
  if (!preview.validation.valid) {
    for (const err of preview.validation.errors ?? []) lines.push(`  ! ${err.code}: ${err.message}`);
  }
  if (preview.steps.length === 0) lines.push('  (no matching capability)');
  for (const step of preview.steps) {
    lines.push(`  - ${step.toolId} risk=${step.risk} auth=${step.authority} policy=${step.policy}` +
      (step.needsConfirm ? ' NEEDS-CONFIRM' : '') + (step.blocked ? ' BLOCKED' : ''));
  }
  return lines.join('\n');
}

main().catch(error => {
  console.error(`Error: ${error?.message || error}`);
  process.exit(1);
});
