// src/tui.ts - Dependency-free MARK TUI (ANSI + raw-mode keys, no deps).
// Views: 1 run · 2 plan · 3 approvals · 4 incidents. npm run tui
import * as dotenv from 'dotenv';
import * as path from 'path';

for (const candidate of [
  path.join(__dirname, '../../.env'),
  path.join(process.cwd(), '../.env'),
  path.join(process.cwd(), '.env'),
]) {
  dotenv.config({ path: candidate });
}

import { markRuntime } from './core/mark-runtime';
import { likeMeLoop } from './core/like-me-loop';
import { config } from './config.js';
import { incidentStore } from './core/incident';

type View = 'run' | 'plan' | 'approvals' | 'incidents';

const ANSI = {
  clear: '\x1b[2J\x1b[H',
  hide: '\x1b[?25l',
  show: '\x1b[?25h',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

interface State {
  view: View;
  input: string;
  lines: string[];
  pending: Array<{ id: string; toolId: string; reason: string }>;
  incidents: Array<{ id: string; title: string; status: string; severity: string }>;
  selected: number;
  busy: boolean;
  kernelTools: number;
}

const state: State = {
  view: 'run',
  input: '',
  lines: ['Welcome to MARK. Type a goal and press Enter. 1-4 switch views, q quits.'],
  pending: [],
  incidents: [],
  selected: 0,
  busy: false,
  kernelTools: 0,
};

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of String(text).split('\n')) {
    let rest = paragraph;
    while (rest.length > width) {
      out.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    out.push(rest);
  }
  return out;
}

function render(): void {
  const width = process.stdout.columns || 100;
  const height = process.stdout.rows || 30;
  const tab = (id: View, n: number, label: string) =>
    state.view === id ? `${ANSI.bold}[${n} ${label}]${ANSI.reset}` : `${ANSI.dim} ${n} ${label} ${ANSI.reset}`;
  let screen = ANSI.clear +
    `${ANSI.bold}${ANSI.cyan}MARK${ANSI.reset} ${ANSI.dim}tools=${state.kernelTools} pending=${state.pending.length} incidents=${state.incidents.length}${ANSI.reset}\n` +
    `${tab('run', 1, 'run')} ${tab('plan', 2, 'plan')} ${tab('approvals', 3, 'approvals')} ${tab('incidents', 4, 'incidents')}\n` +
    '─'.repeat(Math.min(width, 100)) + '\n';

  if (state.view === 'run' || state.view === 'plan') {
    const visible = state.lines.slice(-(height - 6));
    screen += visible.map(line => wrap(line, width).join('\n')).join('\n') + '\n';
  } else if (state.view === 'approvals') {
    if (state.pending.length === 0) {
      screen += `${ANSI.dim}(no pending confirmations)${ANSI.reset}\n`;
    } else {
      state.pending.slice(0, height - 8).forEach((p, i) => {
        const marker = i === state.selected ? `${ANSI.bold}>${ANSI.reset}` : ' ';
        screen += `${marker} ${p.id} ${ANSI.yellow}${p.toolId}${ANSI.reset}\n  ${ANSI.dim}${p.reason.slice(0, width - 4)}${ANSI.reset}\n`;
      });
      screen += `${ANSI.dim}j/k move · a approve · t approve+always · r approve+in-root · d deny${ANSI.reset}\n`;
    }
    try {
      const suggestions = likeMeLoop.suggestTrust().slice(0, 3);
      for (const s of suggestions) {
        screen += `${ANSI.dim}suggested trust: ${s.toolId} (${s.approvedStreak} approved streak)${ANSI.reset}\n`;
      }
    } catch { /* offline */ }
  } else {
    if (state.incidents.length === 0) {
      screen += `${ANSI.dim}(no open incidents)${ANSI.reset}\n`;
    } else {
      state.incidents.slice(0, height - 6).forEach(i => {
        const color = i.severity === 'critical' ? ANSI.red : i.severity === 'high' ? ANSI.yellow : ANSI.green;
        screen += `${color}●${ANSI.reset} ${i.id} [${i.status}] ${i.title.slice(0, width - 30)}\n`;
      });
    }
  }

  const prompt = state.view === 'run' ? 'goal> ' : state.view === 'plan' ? 'plan> ' : '';
  if (prompt) screen += `\n${ANSI.bold}${prompt}${ANSI.reset}${state.input}${state.busy ? ` ${ANSI.dim}(working…)${ANSI.reset}` : ''}`;
  process.stdout.write(screen);
}

async function refresh(): Promise<void> {
  try {
    state.pending = likeMeLoop.listPending().map(p => ({ id: String(p.id), toolId: String(p.toolId), reason: String(p.reason) }));
  } catch { /* offline */ }
  try {
    const open = await incidentStore.getOpenIncidents();
    state.incidents = open.slice(0, 50).map(i => ({ id: i.id, title: i.title, status: i.status, severity: i.severity }));
  } catch { /* offline */ }
  try {
    state.kernelTools = markRuntime.kernelStatus().discoveredTools.length || state.kernelTools;
  } catch { /* not initialized yet */ }
}

function push(line: string): void {
  state.lines.push(line);
  if (state.lines.length > 200) state.lines = state.lines.slice(-200);
}

async function submit(): Promise<void> {
  const goal = state.input.trim();
  state.input = '';
  if (!goal) return;
  state.busy = true;
  render();
  try {
    if (state.view === 'plan') {
      await likeMeLoop.ensureInit();
      const preview = likeMeLoop.preview(goal, 'plan');
      push(`plan: ${preview.goal} (valid=${preview.validation.valid})`);
      for (const step of preview.steps) {
        push(`  - ${step.toolId} risk=${step.risk} auth=${step.authority}` +
          (step.needsConfirm ? ' NEEDS-CONFIRM' : '') + (step.blocked ? ' BLOCKED' : ''));
      }
    } else {
      const result = await markRuntime.executeCommand(goal, config.defaultUser, 'cli');
      push(`[${result.route}] ${result.response}`);
      for (const trace of result.trace ?? []) push(`  ⎿ ${trace}`);
    }
  } catch (error: any) {
    push(`Error: ${error?.message || error}`);
  }
  state.busy = false;
  await refresh();
  render();
}

async function main(): Promise<void> {
  await likeMeLoop.ensureInit().catch(() => {});
  await refresh();
  try {
    await markRuntime.initializeKernel();
    state.kernelTools = markRuntime.kernelStatus().discoveredTools.length;
  } catch { /* offline */ }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('TUI needs an interactive terminal. Use npm run cli -- <command> instead.');
    process.exit(1);
  }
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write(ANSI.hide);
  render();

  const poller = setInterval(async () => {
    if (!state.busy) {
      await refresh();
      render();
    }
  }, 3000);

  process.stdin.on('data', async (chunk: Buffer) => {
    const key = chunk.toString('utf8');
    if (key === '\x03' || key === 'q' && state.input === '') {
      clearInterval(poller);
      process.stdout.write(ANSI.show + '\nCiao, Mwei.\n');
      process.exit(0);
    }
    if (key === '\r' || key === '\n') {
      await submit();
      return;
    }
    if (key === '\x7f' || key === '\b') {
      state.input = state.input.slice(0, -1);
      render();
      return;
    }
    if (state.input === '' && ['1', '2', '3', '4'].includes(key)) {
      state.view = (['run', 'plan', 'approvals', 'incidents'] as View[])[Number(key) - 1];
      state.selected = 0;
      await refresh();
      render();
      return;
    }
    if (state.view === 'approvals' && state.input === '') {
      if (key === 'j') state.selected = Math.min(state.selected + 1, state.pending.length - 1);
      else if (key === 'k') state.selected = Math.max(state.selected - 1, 0);
      else if (key === 'a' || key === 'd' || key === 't' || key === 'r') {
        const current = state.pending[state.selected];
        if (current) {
          const approved = key !== 'd';
          const trust = key === 't' ? 'tool' as const : key === 'r' ? 'root' as const : undefined;
          const record = likeMeLoop.approve(current.id, approved, trust ? { trust } : {});
          push(record
            ? `${approved ? 'approved' : 'denied'} ${record.toolId}` +
              (trust === 'tool' ? ' + trusted always' : trust === 'root' ? ` + trusted in ${record.scopePath ?? 'this root'}` : '')
            : 'already decided');
          await refresh();
        }
      } else return;
      render();
      return;
    }
    if (key.length === 1 && key >= ' ' && key <= '~') {
      state.input += key;
      render();
    }
  });
}

main().catch(error => {
  process.stdout.write(ANSI.show);
  console.error(error);
  process.exit(1);
});
