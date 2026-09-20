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
import { interactionStream } from './core/interaction';
import { config } from './config.js';

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
    '  <text>              chat / route via MarkRuntime (capability, agent, kernel, reasoning)',
    '  /plan <goal>        preview a like-me plan (never executes mutating steps)',
    '  /build <goal>       execute a like-me plan (confirmation-gated)',
    '  /pending            list pending kernel confirmations',
    '  a | t | r | d       approve once / always / in root / deny (single pending)',
    '  /approve [<id>]     approve (defaults to the single pending; resumes it)',
    '  /approve <id>       approve (id, action id, prefix, or app words)',
    '  /approve <id> always approve + allow this tool always',
    '  /approve <id> root   approve + allow this tool in this project root',
    '  /deny <id>          deny (same matching)',
    '  /trust <tool...>    always approve a tool (exact id or id prefix)',
    '  /untrust <tool...>  remove standing trust',
    '  /trustlist          show standing trust grants',
    '  /trace on|off       show what MARK did per command (default on)',
    '  /think on|off       show MARK thinking (routing reasons, compact; default off)',
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

  let showTrace = true;
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
      if (!(rl as any).closed) rl.prompt();
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
        const result = await likeMeLoop.execute(input.slice(7).trim(), { mode: 'build', userId: config.defaultUser, source: 'cli' });
        output = formatPreview(result.preview) + `\nexecuted=${result.executed}` +
          (result.report ? ` status=${(result.report as any).status}` : '') +
          `\npending=${result.pendingConfirmations?.length ?? 0} (use /pending, /approve <id>)`;
      } else if (input === '/pending') {
        const pending = likeMeLoop.listPending();
        output = pending.length === 0 ? '(no pending confirmations)' : pending.map(p => `${p.id} tool=${p.toolId} input=${JSON.stringify(p.input)} reason=${p.reason}`).join('\n');
      } else if (/^[atrd]$/.test(input)) {
        // One keystroke: a=approve once, t=approve+always, r=approve+root,
        // d=deny — applies to the single pending confirmation. With zero or
        // several pending, falls through to chat (say /pending first).
        const pending = likeMeLoop.listPending();
        if (pending.length === 1) {
          const key = input as 'a' | 't' | 'r' | 'd';
          const approved = key !== 'd';
          const trust = key === 't' ? 'tool' as const : key === 'r' ? 'root' as const : undefined;
          if (!approved) {
            const record = likeMeLoop.approve(pending[0].id, false);
            output = record ? `denied ${record.toolId}` : 'already decided';
          } else {
            const resumed = await likeMeLoop.approveAndResume(pending[0].id, config.defaultUser, trust ? { trust } : {});
            output = resumed
              ? `approved ${(resumed.record as { toolId: string }).toolId} → ${(resumed.result as { status?: string }).status}` +
                (trust === 'tool' ? ' + trusted always' : trust === 'root' ? ' + trusted in this root' : '')
              : 'already decided';
          }
        } else {
          output = '';
          stopThinking();
          console.log(`MARK: "${input}" looks like chat. (${pending.length === 0 ? 'No pending confirmations' : `${pending.length} pending — say /pending then /approve <id>`}.)`);
          printHelp();
        }
      } else if (input === '/approve' || input === '/deny') {
        const pending = likeMeLoop.listPending();
        if (pending.length === 1 && input === '/approve') {
          const resumed = await likeMeLoop.approveAndResume(pending[0].id, config.defaultUser);
          output = resumed
            ? `approved ${(resumed.record as { toolId: string }).toolId} → ${(resumed.result as { status?: string }).status}`
            : 'already decided';
        } else output = pending.length === 0
          ? 'Nothing pending. (Approvals do not survive restarts — if you pasted an id from an earlier session, ask again and approve fresh.)'
          : `Pending:\n${pending.map(p => `  ${p.id} tool=${p.toolId}`).join('\n')}\nSay /approve <id or app words>, or just: a approve · t always · r root · d deny.`;
      } else if (input.startsWith('/approve ') || input.startsWith('/deny ')) {
        const approved = input.startsWith('/approve ');
        const raw = input.replace(/^\/(approve|deny)\s+/, '').trim();
        // Trailing keywords: "/approve <id> always" (allow always) or
        // "/approve <id> root" (allow in this project root). Deny ignores them.
        const trust = approved && /\balways$/.test(raw) ? 'tool' as const
          : approved && /\broot$/.test(raw) ? 'root' as const : undefined;
        const text = trust ? raw.replace(/\s+(always|root)$/, '').trim() : raw;
        const verdict = likeMeLoop.resolveApproval(text);
        if (verdict.kind === 'record') {
          if (!approved) {
            const record = likeMeLoop.approve(verdict.record.id, false);
            output = record ? `denied ${record.toolId} (${record.id})` : 'confirmation not found or already decided';
          } else {
            // Approve AND resume: the blocked action re-executes immediately
            // so one approval finishes the job instead of starting a retry loop.
            const resumed = await likeMeLoop.approveAndResume(verdict.record.id, config.defaultUser, trust ? { trust } : {});
            if (!resumed) {
              output = 'confirmation not found or already decided';
            } else {
              const status = (resumed.result as { status?: string }).status ?? 'unknown';
              const summary = (resumed.result as { observations?: Array<{ summary?: string }> }).observations?.slice(-1)[0]?.summary ?? '';
              output = `approved ${(resumed.record as { toolId: string }).toolId} → ${status}${summary ? `: ${summary.slice(0, 200)}` : ''}` +
                (trust === 'tool' ? ' + trusted always' : trust === 'root' ? ' + trusted in this root' : '');
            }
          }
        } else if (verdict.kind === 'ambiguous') {
          output = `Several match "${text}":\n${verdict.candidates.map(c => `  ${c.id} tool=${c.toolId}`).join('\n')}\nBe more specific.`;
        } else {
          output = verdict.pending.length === 0
            ? 'Nothing pending. (Approvals do not survive restarts — if you pasted an id from an earlier session, ask again and approve fresh.)'
            : `No match for "${text}". Pending:\n${verdict.pending.map(p => `  ${p.id} tool=${p.toolId}`).join('\n')}`;
        }
      } else if (input === '/trustlist') {
        const grants = likeMeLoop.listTrusted();
        output = grants.length === 0
          ? '(no standing trust — every gated tool asks each time)'
          : grants.map(g => `  ${g.pattern}${g.scopePath ? ` [root: ${g.scopePath}]` : ''} (since ${g.grantedAt})`).join('\n');
      } else if (input.startsWith('/trust ') || input.startsWith('/untrust ')) {
        const untrusting = input.startsWith('/untrust ');
        const pattern = input.replace(/^\/(un)?trust\s+/, '').trim();
        if (!pattern) {
          output = untrusting ? 'Usage: /untrust <tool id or prefix>' : 'Usage: /trust <tool id or prefix> (e.g. /trust desktop.open.vlc)';
        } else if (untrusting) {
          output = likeMeLoop.untrust(pattern) ? `untrusted ${pattern}` : `no trust grant for ${pattern}`;
        } else {
          likeMeLoop.trust(pattern);
          output = `trusted ${pattern} — matching tools auto-approve from now on (persists across restarts; denied risks stay denied).`;
        }
      } else if (input.startsWith('/trace')) {
        const arg = input.split(/\s+/)[1];
        if (arg === 'off') showTrace = false;
        else if (arg === 'on') showTrace = true;
        output = `trace ${showTrace ? 'on' : 'off'}`;
      } else if (input.startsWith('/think')) {
        const arg = input.split(/\s+/)[1];
        if (arg === 'on') interactionStream.setThinking(true);
        else if (arg === 'off') interactionStream.setThinking(false);
        output = `thinking ${interactionStream.isThinkingOn() ? 'on (routing reasons visible)' : 'off'}`;
      } else if (input.startsWith('/')) {
        output = '';
        stopThinking();
        console.log(`MARK: Unknown command "${input.split(/\s+/)[0]}".`);
        printHelp();
      } else {
        const seen = interactionStream.list().length;
        const result = await markRuntime.executeCommand(input, config.defaultUser, 'cli');
        output = `[${result.route}] ${result.response}`;
        if (showTrace && result.trace?.length) {
          output += `\n  ⎿ ${result.trace.join('\n  ⎿ ')}`;
        }
        if (interactionStream.isThinkingOn()) {
          const fresh = interactionStream.list().slice(seen).filter(e => e.kind === 'thinking' && e.thinking);
          for (const e of fresh) output += `\n  ~ ${e.from}/${e.thinking!.source}: ${e.thinking!.compact}`;
        }
      }
      stopThinking();
      if (output) console.log(`MARK: ${output}\n`);
    } catch (error: any) {
      stopThinking();
      console.log(`Error: ${error.message}\n`);
    }

    if (!(rl as any).closed) rl.prompt();
  }
};

repl().catch(console.error);
