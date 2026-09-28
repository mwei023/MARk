/**
 * ScreenAgent: Mark's computer-use agent. Sees, reasons, acts, verifies.
 *
 * Loop (bounded, budgeted): screenshot → vision model (what is on screen?
 * is the goal done? what next?) → one kernel-gated action → screenshot →
 * verify. Every observation and action lands in the incident trail; the run
 * ends done, budget-spent, or blocked — never silent.
 *
 * Safety: observation is always allowed; pointer/keyboard actions are kernel
 * risk-mutating tools, so outside test mode each one waits for human
 * confirmation like every other mutating tool.
 */
import { Agent } from '../core/agent-runtime';
import { Event } from '../core/events';
import { incidentStore } from '../core/incident';
import { eventBus } from '../core/event-bus';
import { config } from '../config.js';

export interface ScreenGoal {
  task: string;
  maxSteps?: number;
}

interface VisionVerdict {
  observation: string;
  done: boolean;
  action: { tool: string; input: Record<string, unknown> } | null;
  reason: string;
}

const VISION_SYSTEM = `You operate a Linux desktop by looking at screenshots. Reply with EXACTLY one JSON object, no other text:
{"observation": "what is visible, one sentence", "done": true/false, "action": {"tool": "screen.mouse_move"|"screen.click"|"screen.type"|"screen.key", "input": {...}} or null, "reason": "why this action next, one sentence"}
Rules:
- Coordinates are 0-1000 normalized (x left→right, y top→bottom) over the screenshot AS GIVEN. The executor scales them to pixels.
- "done": true only when the task goal is visibly complete. Otherwise propose exactly ONE next action.
- Prefer the smallest safe move: move mouse before clicking; never type into an unknown focused window (move+click the target field first).
- If the screen shows nothing actionable for the goal, set action null with done false and say what is missing.`;

async function seeScreenshot(repoHint: string): Promise<{ imageBase64: string; width: number } | null> {
  void repoHint;
  const { markKernelBridge } = await import('../kernel/bridge.js');
  await markKernelBridge.initialize();
  const action = {
    id: `ACT-${Date.now()}-see`,
    toolId: 'screen.observe',
    input: { maxWidth: 640 },
    requestedBy: 'screen-agent',
    createdAt: new Date().toISOString(),
  } as never;
  const context = markKernelBridge.createContext({ userId: config.defaultUser, source: 'api' } as never);
  const result = await markKernelBridge.execute(action, context);
  const out = (result as { output?: unknown }).output as Record<string, unknown> | undefined;
  if (result.status === 'succeeded' && out && typeof out.imageBase64 === 'string') {
    return { imageBase64: out.imageBase64 as string, width: Number(out.width ?? 640) };
  }
  return null;
}

async function askVision(task: string, imageBase64: string, history: string[]): Promise<VisionVerdict> {
  const key = config.openrouterApiKey;
  const content = await (key ? askVisionOpenRouter(key, task, imageBase64, history) : askVisionOllama(task, imageBase64, history));
  return parseVisionVerdict(content);
}

/** Shared verdict parsing for both vision backends (cloud + local). */
export function parseVisionVerdict(content: string): VisionVerdict {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`Vision returned no JSON (excerpt: ${content.slice(0, 120)})`);
  const parsed = JSON.parse(content.slice(start, end + 1)) as Partial<VisionVerdict>;
  return {
    observation: typeof parsed.observation === 'string' ? parsed.observation : 'no observation',
    done: parsed.done === true,
    action: parsed.action && typeof parsed.action.tool === 'string' ? { tool: parsed.action.tool, input: parsed.action.input ?? {} } : null,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
  };
}

/**
 * Local vision via Ollama (e.g. moondream): free, offline, private. Used
 * whenever no OpenRouter key is configured. Same verdict contract.
 */
async function askVisionOllama(task: string, imageBase64: string, history: string[]): Promise<string> {
  const model = process.env.MARK_VISION_MODEL_OLLAMA ?? 'moondream';
  let res: Response;
  try {
    res = await fetch(`${config.ollamaHost}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        options: { temperature: 0 },
        messages: [
          { role: 'system', content: VISION_SYSTEM },
          {
            role: 'user',
            content: `Task: ${task}\n${history.length > 0 ? `Prior steps:\n${history.slice(-6).join('\n')}\n` : ''}Decide the next step.`,
            images: [imageBase64],
          },
        ],
      }),
      signal: AbortSignal.timeout(180000),
    });
  } catch (err) {
    throw new Error(`Local vision unavailable (Ollama ${model}): ${err instanceof Error ? err.message.slice(0, 120) : String(err)}. Run "ollama pull ${model}" or set OPENROUTER_API_KEY.`);
  }
  if (!res.ok) throw new Error(`Local vision failed: HTTP ${res.status}. Run "ollama pull ${model}" or set OPENROUTER_API_KEY.`);
  const body = (await res.json()) as { message?: { content?: string }; error?: string };
  if (body.error) throw new Error(`Local vision error: ${body.error}`);
  return body.message?.content ?? '';
}

async function askVisionOpenRouter(key: string, task: string, imageBase64: string, history: string[]): Promise<string> {
  const model = process.env.MARK_VISION_MODEL ?? 'deepseek/deepseek-v4-flash-vision-exp';
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 800,
      messages: [
        { role: 'system', content: VISION_SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'text', text: `Task: ${task}\n${history.length > 0 ? `Prior steps:\n${history.slice(-6).join('\n')}\n` : ''}Decide the next step.` },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(150000),
  });
  if (!res.ok) throw new Error(`Vision call failed: HTTP ${res.status}`);
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
  if (body.error) throw new Error(`Vision error: ${body.error.message}`);
  return body.choices?.[0]?.message?.content ?? '';
}

export class ScreenAgent extends Agent {
  constructor() {
    super('screen-agent');
  }

  canHandle(event: Event): boolean {
    return event.type === 'screen.task.requested';
  }

  async handle(event: Event): Promise<void> {
    const data = event.data as Record<string, any>;
    const task = String(data.task ?? '').slice(0, 500);
    const incidentId = typeof data.incidentId === 'string' ? data.incidentId : undefined;
    const maxSteps = Math.min(Math.max(Number(data.maxSteps) || 6, 1), 12);

    const find = async (text: string): Promise<void> => {
      if (incidentId) await incidentStore.addFinding(incidentId, text);
    };
    console.log(`[ScreenAgent] Task: ${task || '(empty)'}`);
    if (!task) {
      await find('Screen task rejected: empty task description.');
      await this.complete(event, incidentId, false, 'empty task');
      return;
    }

    const history: string[] = [];
    let done = false;
    try {
      const { markKernelBridge } = await import('../kernel/bridge.js');
      await markKernelBridge.initialize();
      for (let step = 1; step <= maxSteps && !done; step++) {
        const shot = await seeScreenshot(task);
        if (!shot) {
          await find(`Step ${step}: screenshot unavailable — display unreachable.`);
          break;
        }
        let verdict: VisionVerdict;
        try {
          verdict = await askVision(task, shot.imageBase64, history);
        } catch (err) {
          await find(`Step ${step}: vision failed (${err instanceof Error ? err.message.slice(0, 160) : String(err)}).`);
          break;
        }
        await find(`Step ${step} sees: ${verdict.observation}`);
        history.push(`Step ${step}: ${verdict.observation} → ${verdict.action ? `${verdict.action.tool} ${JSON.stringify(verdict.action.input)}` : verdict.done ? 'done' : 'no action'}`);
        if (verdict.done || !verdict.action) {
          done = verdict.done;
          await find(verdict.done ? `Task looks complete: ${verdict.reason}` : `Stopping: ${verdict.reason || 'no actionable step'}`);
          break;
        }
        // Scale normalized coords to the observed pixel width (assume 16:9 for height).
        const input = { ...verdict.action.input };
        if (typeof input.x === 'number') input.x = Math.round((input.x / 1000) * 1920);
        if (typeof input.y === 'number') input.y = Math.round((input.y / 1000) * 1080);
        const action = {
          id: `ACT-${Date.now()}-s${step}`,
          toolId: verdict.action.tool,
          input,
          requestedBy: 'screen-agent',
          createdAt: new Date().toISOString(),
        } as never;
        const context = markKernelBridge.createContext({ userId: config.defaultUser, source: 'api' } as never);
        const result = await markKernelBridge.execute(action, context);
        const status = (result as { status?: string }).status;
        await find(`Step ${step} acted (${verdict.action.tool}): ${status}. Reason: ${verdict.reason}`);
        if (status === 'blocked') {
          await find('Action gated for confirmation — stopping loop until approved.');
          break;
        }
        if (status !== 'succeeded') {
          await find('Action did not succeed — stopping loop.');
          break;
        }
      }
      await this.complete(event, incidentId, done, done ? 'goal visibly complete' : 'budget spent or blocked');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[ScreenAgent] Task failed:', msg);
      await find(`Screen task failed safely: ${msg.slice(0, 200)}`);
      await this.complete(event, incidentId, false, `failed: ${msg.slice(0, 120)}`);
    } finally {
      console.log(`[ScreenAgent] Completed task (done=${done})`);
    }
  }

  private async complete(event: Event, incidentId: string | undefined, done: boolean, summary: string): Promise<void> {
    await eventBus.emit({
      id: `EVT-${Date.now()}`,
      timestamp: new Date(),
      source: 'screen-agent',
      type: 'screen.task.completed',
      severity: done ? 'info' : 'warning',
      correlationId: event.correlationId || 'screen',
      data: { incidentId, done, summary },
    } as any);
  }
}
