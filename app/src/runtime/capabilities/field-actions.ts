import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { Capability } from './registry';

const execFilePromise = promisify(execFile);

/** Pipe text into a command's stdin (execFile has no input option). */
function pipeInput(cmd: string, args: string[], text: string, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { timeout: timeoutMs });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    child.stdin.write(text);
    child.stdin.end();
  });
}

/**
 * Phase 2 of the mark-runtime merge: computer-use tools as capabilities.
 *
 * Read-only evidence tools (screenshot, camshot) are auto-allowed via the
 * policy-bridge `read` mapping. GUI-mutating tools (click, type) declare
 * mutating risk through the shared `agentActionRisk` vocabulary
 * (field_click / field_type fall to the default mutating branch), so the
 * agent tool path gates them behind block/confirm before they run.
 *
 * Every mutating execute captures before/after screenshots: the paths are
 * the evidence attached to approval requests and the incident audit trail.
 */
export async function evidenceShot(prefix = 'field'): Promise<string> {
  const path = `/tmp/${prefix}-${Date.now()}.png`;
  try {
    await execFilePromise('xwd', ['-root', '-silent', '-out', '/tmp/field.xwd'], { timeout: 15000 });
    await execFilePromise('convert', ['/tmp/field.xwd', path], { timeout: 15000 });
    return path;
  } catch {
    await execFilePromise('import', ['-window', 'root', path], { timeout: 15000 });
    return path;
  }
}

export class FieldScreenshotCapability implements Capability {
  id = 'field.screenshot';
  name = 'Field screen evidence';

  canHandle(input: string): boolean {
    return /\bscreenshot|screen shot|show (me )?the screen|what's on screen|what is on screen\b/i.test(input);
  }

  async execute(_input: string): Promise<string> {
    const path = await evidenceShot('field-shot');
    return `evidence: ${path}`;
  }
}

export class FieldCamshotCapability implements Capability {
  id = 'field.camshot';
  name = 'Field webcam evidence';

  canHandle(input: string): boolean {
    return /\bcamshot|cam shot|webcam|take (a )?picture|photo of me\b/i.test(input);
  }

  async execute(_input: string): Promise<string> {
    const path = `/tmp/field-cam-${Date.now()}.jpg`;
    await execFilePromise('ffmpeg',
      ['-y', '-f', 'v4l2', '-input_format', 'mjpeg', '-video_size', '1280x720',
       '-i', '/dev/video0', '-frames:v', '1', path],
      { timeout: 30000 });
    return `evidence: ${path}`;
  }
}

function parseCoords(input: string): { x: number; y: number } | undefined {
  const m = input.match(/(\d{1,4})\s*,\s*(\d{1,4})/);
  if (!m) return undefined;
  return { x: Number(m[1]), y: Number(m[2]) };
}

export class FieldClickCapability implements Capability {
  id = 'field.click';
  name = 'Field GUI click (mutating, gated)';

  canHandle(input: string): boolean {
    return /\bclick (at|on) \d{1,4}\s*,\s*\d{1,4}\b/i.test(input);
  }

  async execute(input: string): Promise<string> {
    const coords = parseCoords(input);
    if (!coords) return 'Refused: need explicit "click at X,Y" coordinates.';
    const before = await evidenceShot('field-click-before');
    await execFilePromise('xdotool', ['mousemove', '--sync', String(coords.x), String(coords.y)], { timeout: 15000 });
    await execFilePromise('xdotool', ['click', '1'], { timeout: 15000 });
    const after = await evidenceShot('field-click-after');
    return `clicked ${coords.x},${coords.y}\nevidence-before: ${before}\nevidence-after: ${after}`;
  }
}

export class FieldTypeCapability implements Capability {
  id = 'field.type';
  name = 'Field GUI typing (mutating, gated)';

  canHandle(input: string): boolean {
    return /\b(field type:|type into|type text:|paste text:)/i.test(input);
  }

  async execute(input: string): Promise<string> {
    const text = input.replace(/.*?(field type:|type into|type text:|paste text:)\s*/i, '').trim();
    if (!text) return 'Refused: need text after "type text: ...".';
    const before = await evidenceShot('field-type-before');
    await pipeInput('xclip', ['-selection', 'clipboard'], text);
    await execFilePromise('xdotool', ['key', 'ctrl+v'], { timeout: 15000 });
    const after = await evidenceShot('field-type-after');
    return `typed ${text.length} chars\nevidence-before: ${before}\nevidence-after: ${after}`;
  }
}
