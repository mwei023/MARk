/**
 * Assistant provider (task.* + schedule.*): local-first tasks and calendar.
 *
 * No external sync (no CalDAV/Google): rows live in assistant_tasks /
 * assistant_events (migration 009). Reads are risk-read; creates and
 * state changes are risk-reversible (confirmation-gated, never denied).
 * Dates accept ISO strings plus common relative forms ("tomorrow 10:00",
 * "in 2 hours", "friday 14:00"), parsed deterministically in server
 * local time. Vague remind-frames ("remind me to X") need values the
 * goal never states — smart binding extracts them, otherwise the kernel
 * asks explicitly. Same contract as skill.install.
 */
import { getPool } from '../../db/postgres';
import {
  DiscoveryProvider,
  ToolDescriptor,
  ToolImplementation,
  ToolParameterSchema,
} from '../index';

const TITLE_MAX = 300;
const NOTES_MAX = 10000;
const LIST_MAX = 50;

function failOutput(reason: string): Record<string, unknown> {
  return { ok: false, reason: reason.slice(0, 300), capturedAt: new Date().toISOString() };
}

function db(): { pool: ReturnType<typeof getPool> } {
  try {
    return { pool: getPool() };
  } catch (err) {
    throw new Error(`Database unavailable: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
  }
}

function checkTitle(title: unknown): string {
  const t = String(title ?? '').trim().slice(0, TITLE_MAX);
  if (!t) throw new Error('Refused: task/event title is required.');
  return t;
}

function checkNotes(notes: unknown): string {
  return String(notes ?? '').slice(0, NOTES_MAX);
}

function checkLimit(l: unknown, def = 10): number {
  if (l === undefined || l === null || String(l).trim() === '') return def;
  const v = typeof l === 'number' ? l : Number(String(l).trim());
  if (!Number.isFinite(v)) return def;
  return Math.min(Math.max(Math.floor(v), 1), LIST_MAX);
}

function checkId(id: unknown, what: string): string {
  const v = String(id ?? '').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw new Error(`Refused: invalid ${what} id.`);
  return v;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Deterministic date parser. ISO 8601 first, then relative forms, all in
 * server local time. Returns undefined when nothing parses (caller fails
 * closed with the accepted formats).
 */
export function parseWhen(raw: string, now = new Date()): Date | undefined {
  const text = String(raw ?? '').trim();
  if (!text) return undefined;
  // Full timestamps parse as-is; bare dates fall through to the local
  // YYYY-MM-DD branch below (09:00 default) instead of UTC midnight.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d/.test(text)) {
    const iso = new Date(text);
    if (!Number.isNaN(iso.getTime())) return iso;
    return undefined;
  }

  const lower = text.toLowerCase();
  const at = (base: Date, hh: string, mm?: string): Date => {
    const d = new Date(base);
    d.setHours(Number(hh), Number(mm ?? '00'), 0, 0);
    return d;
  };
  let m: RegExpMatchArray | null;

  m = lower.match(/^(today|tonight)(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/);
  if (m) {
    const d = m[2] !== undefined ? withMeridiem(at(now, m[2], m[3]), m[2], m[4]) : endOfDay(now);
    return d;
  }
  m = lower.match(/^tomorrow(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/);
  if (m) {
    const base = new Date(now);
    base.setDate(base.getDate() + 1);
    return m[1] !== undefined ? withMeridiem(at(base, m[1], m[2]), m[1], m[3]) : startOfDay(base);
  }
  m = lower.match(/^in\s+(\d+)\s+(minutes?|hours?|days?|weeks?)$/);
  if (m) {
    const n = Number(m[1]);
    const mult = /minute/.test(m[2]) ? 60000 : /hour/.test(m[2]) ? 3600000 : /day/.test(m[2]) ? 86400000 : 604800000;
    return new Date(now.getTime() + n * mult);
  }
  m = lower.match(/^(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/);
  if (m) {
    const want = WEEKDAYS.indexOf(m[1]);
    const d = new Date(now);
    let delta = (want - d.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    d.setDate(d.getDate() + delta);
    return m[2] !== undefined ? withMeridiem(at(d, m[2], m[3]), m[2], m[4]) : startOfDay(d);
  }
  m = lower.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (m) {
    let d = withMeridiem(at(now, m[1], m[2]), m[1], m[3]);
    if (d.getTime() <= now.getTime()) {
      d = new Date(d);
      d.setDate(d.getDate() + 1);
    }
    return d;
  }
  m = lower.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2})(?::(\d{2}))?)?$/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? '09'), Number(m[5] ?? '00'), 0, 0);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return undefined;
}

function withMeridiem(d: Date, hh: string, meridiem: string | undefined): Date {
  if (!meridiem) return d;
  let h = Number(hh) % 12;
  if (meridiem === 'pm') h += 12;
  const out = new Date(d);
  out.setHours(h);
  return out;
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(9, 0, 0, 0);
  return out;
}

function endOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(23, 59, 0, 0);
  return out;
}

function checkWhen(value: unknown, what: string): string {
  const parsed = parseWhen(String(value ?? ''));
  if (!parsed) {
    throw new Error(`Refused: cannot parse ${what} ${JSON.stringify(String(value ?? '')).slice(0, 80)}. Use ISO dates or forms like "tomorrow 10:00", "in 2 hours", "friday 14:00".`);
  }
  return parsed.toISOString();
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const titleProp: ToolParameterSchema = { type: 'string', description: 'Short title text.' };
const notesProp: ToolParameterSchema = { type: 'string', description: 'Longer notes text (optional).' };

function mutTool(
  id: string, name: string, description: string,
  properties: Record<string, ToolParameterSchema>, required: string[],
): ToolDescriptor {
  return {
    id, name, description, version: '1.0.0', domain: 'assistant', risk: 'reversible',
    available: true,
    inputSchema: { type: 'object', properties, required },
    capabilities: ['assistant-tasks', 'personal-organization'],
    supportedResourceKinds: [],
    requiredPermissions: [],
    reversible: true,
    metadata: {},
    provider: 'assistant.native',
  };
}

function readAssistantTool(
  id: string, name: string, description: string,
  properties: Record<string, ToolParameterSchema>, required: string[],
): ToolDescriptor {
  return { ...mutTool(id, name, description, properties, required), risk: 'read' };
}

export const taskCreateTool = mutTool(
  'task.create', 'Create task',
  'Adds a personal task, todo, or reminder with optional priority and due date. Use to add todos, reminders, and follow-ups.',
  {
    title: titleProp, notes: notesProp,
    priority: { type: 'string', description: 'low, normal, or high (default normal).' },
    due: { type: 'string', description: 'Due date: ISO or relative like "tomorrow 10:00", "in 2 hours", "friday".' },
  },
  ['title'],
);

export const taskListTool = readAssistantTool(
  'task.list', 'List tasks',
  'Lists personal tasks with their status, priority, and due dates. Use to review what is open or due.',
  {
    status: { type: 'string', description: 'open, done, cancelled, or all (default open).' },
    limit: { type: 'number', description: 'Max tasks (1-50, default 10).' },
  },
  [],
);

export const taskCompleteTool = mutTool(
  'task.complete', 'Complete task',
  'Marks a personal task done by id. Use when a todo or reminder is finished.',
  { id: { type: 'string', description: 'Task id from task.list.' } },
  ['id'],
);

export const taskCancelTool = mutTool(
  'task.cancel', 'Cancel task',
  'Cancels a personal task by id without deleting it. Use when a todo is no longer needed.',
  { id: { type: 'string', description: 'Task id from task.list.' } },
  ['id'],
);

export const scheduleCreateTool = mutTool(
  'schedule.create', 'Schedule event',
  'Adds a calendar event with a start time and optional end, location, and notes. Use to add meetings, appointments, and plans.',
  {
    title: titleProp, notes: notesProp,
    starts_at: { type: 'string', description: 'Start: ISO or relative like "tomorrow 10:00", "friday 14:00", "in 2 hours".' },
    ends_at: { type: 'string', description: 'End time, same formats (optional).' },
    location: { type: 'string', description: 'Where the event happens (optional).' },
  },
  ['title', 'starts_at'],
);

export const scheduleListTool = readAssistantTool(
  'schedule.list', 'List agenda',
  'Lists scheduled calendar events in a time window with titles, times, and locations. Use to review the agenda, calendar, or answer what is coming up.',
  {
    from: { type: 'string', description: 'Window start, ISO or relative (default now).' },
    to: { type: 'string', description: 'Window end (default 7 days out).' },
    limit: { type: 'number', description: 'Max events (1-50, default 10).' },
  },
  [],
);

export const scheduleCancelTool = mutTool(
  'schedule.cancel', 'Cancel event',
  'Cancels a scheduled event by id. Use when a meeting or plan is called off.',
  { id: { type: 'string', description: 'Event id from schedule.list.' } },
  ['id'],
);

const VALID_TASK_STATUS = new Set(['open', 'done', 'cancelled', 'all']);
const VALID_PRIORITY = new Set(['low', 'normal', 'high']);

export const taskCreateImplementation: ToolImplementation = {
  toolId: taskCreateTool.id,
  async execute({ action }) {
    try {
      const input = action.input as Record<string, unknown>;
      const title = checkTitle(input.title);
      const notes = checkNotes(input.notes);
      const priority = String(input.priority ?? 'normal').trim().toLowerCase();
      if (!VALID_PRIORITY.has(priority)) throw new Error('Refused: priority must be low, normal, or high.');
      const due = input.due === undefined || input.due === null || String(input.due).trim() === ''
        ? null : checkWhen(input.due, 'due date');
      const id = newId('task');
      const { pool } = db();
      await pool.query(
        `INSERT INTO assistant_tasks (id, title, notes, status, priority, due_at) VALUES ($1, $2, $3, 'open', $4, $5)`,
        [id, title, notes, priority, due],
      );
      const output = { id, title, priority, due_at: due, capturedAt: new Date().toISOString() };
      return {
        output,
        observations: [{
          id: `observation-${Date.now()}`, kind: 'output' as const, source: 'assistant.native', subject: id,
          summary: `Created task "${title}"${due ? ` due ${due}` : ''} (confirmation granted).`,
          data: output, confidence: 1, observedAt: output.capturedAt, relatedResourceIds: [],
        }],
      };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

export const taskListImplementation: ToolImplementation = {
  toolId: taskListTool.id,
  async execute({ action }) {
    try {
      const input = action.input as Record<string, unknown>;
      const status = String(input.status ?? 'open').trim().toLowerCase();
      if (!VALID_TASK_STATUS.has(status)) throw new Error('Refused: status must be open, done, cancelled, or all.');
      const limit = checkLimit(input.limit);
      const { pool } = db();
      const rows = (await pool.query(
        `SELECT id, title, notes, status, priority, due_at, created_at, completed_at FROM assistant_tasks
         ${status === 'all' ? '' : 'WHERE status = $1'}
         ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC NULLS LAST, created_at DESC LIMIT $${status === 'all' ? 1 : 2}`,
        status === 'all' ? [limit] : [status, limit],
      )).rows;
      const output = { count: rows.length, tasks: rows, capturedAt: new Date().toISOString() };
      return {
        output,
        observations: [{
          id: `observation-${Date.now()}`, kind: 'output' as const, source: 'assistant.native', subject: 'tasks',
          summary: `${rows.length} ${status} task(s).`,
          data: output, confidence: 1, observedAt: output.capturedAt, relatedResourceIds: [],
        }],
      };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

async function setTaskStatus(id: string, status: 'done' | 'cancelled'): Promise<Record<string, unknown>> {
  const taskId = checkId(id, 'task');
  const { pool } = db();
  const r = await pool.query(
    `UPDATE assistant_tasks SET status = $1::varchar, updated_at = NOW(),
       completed_at = CASE WHEN $1::varchar = 'done' THEN NOW() ELSE completed_at END
     WHERE id = $2 RETURNING id, title, status`,
    [status, taskId],
  );
  if (r.rows.length === 0) return failOutput(`No task with id ${JSON.stringify(taskId)}.`);
  return { ok: true, ...(r.rows[0] as object), capturedAt: new Date().toISOString() };
}

export const taskCompleteImplementation: ToolImplementation = {
  toolId: taskCompleteTool.id,
  async execute({ action }) {
    try {
      const output = await setTaskStatus(String((action.input as Record<string, unknown>).id ?? ''), 'done');
      if ((output as { ok?: boolean }).ok !== true) return { output };
      return {
        output,
        observations: [{
          id: `observation-${Date.now()}`, kind: 'output' as const, source: 'assistant.native',
          subject: String((output as { id?: string }).id ?? ''),
          summary: `Completed task "${String((output as { title?: string }).title ?? '')}" (confirmation granted).`,
          data: output, confidence: 1, observedAt: String((output as { capturedAt?: string }).capturedAt ?? new Date().toISOString()), relatedResourceIds: [],
        }],
      };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

export const taskCancelImplementation: ToolImplementation = {
  toolId: taskCancelTool.id,
  async execute({ action }) {
    try {
      const output = await setTaskStatus(String((action.input as Record<string, unknown>).id ?? ''), 'cancelled');
      if ((output as { ok?: boolean }).ok !== true) return { output };
      return {
        output,
        observations: [{
          id: `observation-${Date.now()}`, kind: 'output' as const, source: 'assistant.native',
          subject: String((output as { id?: string }).id ?? ''),
          summary: `Cancelled task "${String((output as { title?: string }).title ?? '')}" (confirmation granted).`,
          data: output, confidence: 1, observedAt: String((output as { capturedAt?: string }).capturedAt ?? new Date().toISOString()), relatedResourceIds: [],
        }],
      };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

export const scheduleCreateImplementation: ToolImplementation = {
  toolId: scheduleCreateTool.id,
  async execute({ action }) {
    try {
      const input = action.input as Record<string, unknown>;
      const title = checkTitle(input.title);
      const startsAt = checkWhen(input.starts_at, 'start time');
      const endsAt = input.ends_at === undefined || input.ends_at === null || String(input.ends_at).trim() === ''
        ? null : checkWhen(input.ends_at, 'end time');
      if (endsAt && new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
        throw new Error('Refused: event ends before it starts.');
      }
      const id = newId('evt');
      const { pool } = db();
      await pool.query(
        `INSERT INTO assistant_events (id, title, notes, starts_at, ends_at, location, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'scheduled')`,
        [id, title, checkNotes(input.notes), startsAt, endsAt, String(input.location ?? '').slice(0, 300)],
      );
      const output = { id, title, starts_at: startsAt, ends_at: endsAt, capturedAt: new Date().toISOString() };
      return {
        output,
        observations: [{
          id: `observation-${Date.now()}`, kind: 'output' as const, source: 'assistant.native', subject: id,
          summary: `Scheduled "${title}" at ${startsAt} (confirmation granted).`,
          data: output, confidence: 1, observedAt: output.capturedAt, relatedResourceIds: [],
        }],
      };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

export const scheduleListImplementation: ToolImplementation = {
  toolId: scheduleListTool.id,
  async execute({ action }) {
    try {
      const input = action.input as Record<string, unknown>;
      const from = input.from === undefined || input.from === null || String(input.from).trim() === ''
        ? new Date().toISOString() : checkWhen(input.from, 'window start');
      const to = input.to === undefined || input.to === null || String(input.to).trim() === ''
        ? new Date(Date.now() + 7 * 86400000).toISOString() : checkWhen(input.to, 'window end');
      const limit = checkLimit(input.limit);
      const { pool } = db();
      const rows = (await pool.query(
        `SELECT id, title, notes, starts_at, ends_at, location, status FROM assistant_events
         WHERE status = 'scheduled' AND starts_at >= $1 AND starts_at <= $2
         ORDER BY starts_at ASC LIMIT $3`,
        [from, to, limit],
      )).rows;
      const output = { count: rows.length, events: rows, capturedAt: new Date().toISOString() };
      return {
        output,
        observations: [{
          id: `observation-${Date.now()}`, kind: 'output' as const, source: 'assistant.native', subject: 'agenda',
          summary: `${rows.length} event(s) coming up.`,
          data: output, confidence: 1, observedAt: output.capturedAt, relatedResourceIds: [],
        }],
      };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

export const scheduleCancelImplementation: ToolImplementation = {
  toolId: scheduleCancelTool.id,
  async execute({ action }) {
    try {
      const id = checkId(String((action.input as Record<string, unknown>).id ?? ''), 'event');
      const { pool } = db();
      const r = await pool.query(
        `UPDATE assistant_events SET status = 'cancelled', updated_at = NOW() WHERE id = $1 RETURNING id, title`,
        [id],
      );
      if (r.rows.length === 0) return { output: failOutput(`No event with id ${JSON.stringify(id)}.`) };
      const output = { ok: true, ...(r.rows[0] as object), capturedAt: new Date().toISOString() };
      return {
        output,
        observations: [{
          id: `observation-${Date.now()}`, kind: 'output' as const, source: 'assistant.native', subject: id,
          summary: `Cancelled event "${String((r.rows[0] as { title?: string }).title ?? '')}" (confirmation granted).`,
          data: output, confidence: 1, observedAt: output.capturedAt, relatedResourceIds: [],
        }],
      };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

export const assistantTools: ToolDescriptor[] = [
  taskCreateTool, taskListTool, taskCompleteTool, taskCancelTool,
  scheduleCreateTool, scheduleListTool, scheduleCancelTool,
];
export const assistantImplementations: ToolImplementation[] = [
  taskCreateImplementation, taskListImplementation, taskCompleteImplementation, taskCancelImplementation,
  scheduleCreateImplementation, scheduleListImplementation, scheduleCancelImplementation,
];

export const assistantDiscoveryProvider: DiscoveryProvider = {
  id: 'assistant.native',
  name: 'Assistant provider',
  description: 'Personal tasks and calendar events: create, list, complete, and cancel.',
  priority: 80,
  async isAvailable(): Promise<boolean> {
    return true;
  },
  async discoverResources(): Promise<never[]> {
    return [];
  },
  async discoverTools(): Promise<ToolDescriptor[]> {
    return assistantTools;
  },
};
