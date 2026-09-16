// src/repl.ts - Interactive MARK REPL (Phase 1: CommonJS + like-me commands)
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load env: repo-root .env first (LLM keys), then app/.env fills gaps.
// dotenv never overrides already-set vars, so shell exports always win.
for (const candidate of [
  path.join(__dirname, '../../.env'),
  path.join(process.cwd(), '../.env'),
  path.join(process.cwd(), '.env'),
]) {
  dotenv.config({ path: candidate });
}

import { markRuntime } from './core/mark-runtime';
import { likeMeLoop } from './core/like-me-loop';

const animateThinking = () => {
  let dots = 0;
  const interval = setInterval(() => {
    process.stdout.write(`\rMARK${'.'.repeat(dots)}   `);
    dots = (dots + 1) % 4;
  }, 300);
  return () => clearInterval(interval);
};

const printHelp = () => {
  console.log([
    'Commands:',
    '  <text>              chat / route via MarkRuntime (capability, agent, reasoning)',
    '  /plan <goal>        preview a like-me plan (never executes mutating steps)',
    '  /build <goal>       execute a like-me plan (confirmation-gated)',
    '  /pending            list pending kernel confirmations',
    '  /approve <id>       approve a confirmation',
    '  /deny <id>          deny a confirmation',
    '  /help               this help',
    "  quit | exit         leave ('Ciao, Mwei.')",
    '',
  ].join('\n'));
};

const formatPreview = (preview: any): string => {
  const lines = [
    `goal: ${preview.goal} (mode=${preview.mode}, valid=${preview.validation.valid})`,
  ];
  if (!preview.validation.valid) {
    for (const err of preview.validation.errors ?? []) {
      lines.push(`  ! ${err.code}: ${err.message}`);
    }
  }
  if (preview.steps.length === 0) lines.push('  (no matching capability — try different words)');
  for (const step of preview.steps) {
    const input = JSON.stringify((step as any).input ?? (preview.plan.steps.find((s: any) => s.id === step.stepId)?.input ?? {}));
    lines.push(
      `  - ${step.toolId} risk=${step.risk} auth=${step.authority} policy=${step.policy}` +
        (step.needsConfirm ? ' NEEDS-CONFIRM' : '') +
        (step.blocked ? ' BLOCKED' : '') +
        ` input=${input}`,
    );
  }
  return lines.join('\n');
};

// Simple REPL loop
const repl = async () => {
  await likeMeLoop.ensureInit();
  console.log("MARK interactive. Type /help for commands, 'quit' to stop.\n");

  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'You: ',
  });

  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();

    if (['quit', 'exit', 'q'].includes(input.toLowerCase())) {
      console.log('MARK: Ciao, Mwei.');
      rl.close();
      break;
    }

    if (!input) {
      if (!rl.closed) rl.prompt();
      continue;
    }

    const stopThinking = animateThinking();
    try {
      let output: string;
      if (input === '/help') {
        output = '';
        stopThinking();
        printHelp();
      } else if (input.startsWith('/plan ')) {
        const preview = likeMeLoop.preview(input.slice(6).trim(), 'plan');
        output = formatPreview(preview);
      } else if (input.startsWith('/build ')) {
        const result = await likeMeLoop.execute(input.slice(7).trim(), { mode: 'build', userId: 'mwei', source: 'cli' });
        output = formatPreview(result.preview) + `\nexecuted=${result.executed}` +
          (result.report ? ` status=${(result.report as any).status}` : '') +
          `\npending=${result.pendingConfirmations?.length ?? 0} (use /pending, /approve <id>)`;
      } else if (input === '/pending') {
        const pending = likeMeLoop.listPending();
        output = pending.length === 0 ? '(no pending confirmations)' : pending.map(p => `${p.id} tool=${p.toolId} input=${JSON.stringify(p.input)} reason=${p.reason}`).join('\n');
      } else if (input.startsWith('/approve ') || input.startsWith('/deny ')) {
        const approved = input.startsWith('/approve ');
        const id = input.split(/\s+/)[1];
        const record = likeMeLoop.approve(id, approved);
        output = record ? `${record.id} -> ${record.status}` : 'confirmation not found or already decided';
      } else {
        const result = await markRuntime.executeCommand(input, 'mwei', 'cli');
        output = `[${result.route}] ${result.response}`;
      }
      stopThinking();
      if (output) console.log(`MARK: ${output}\n`);
    } catch (error: any) {
      stopThinking();
      console.log(`Error: ${error.message}\n`);
    }

    if (!rl.closed) rl.prompt();
  }
};

repl().catch(console.error);
