import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import {
  DiscoveryProvider,
  ResourceDescriptor,
  ToolDescriptor,
  ToolImplementation,
} from '../index';

export const systemMachineInfoTool: ToolDescriptor = {
  id: 'system.machine_info',
  name: 'Machine information',
  description:
    'Reads basic information about the local machine without modifying anything.',
  version: '1.0.0',
  domain: 'system',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  outputSchema: {
    type: 'object',
    properties: {
      platform: { type: 'string' },
      architecture: { type: 'string' },
      hostname: { type: 'string' },
      operatingSystem: { type: 'string' },
      cpuCount: { type: 'number' },
      cpuModel: { type: 'string' },
      memory: {
        type: 'object',
        properties: {
          totalBytes: { type: 'number' },
          freeBytes: { type: 'number' },
          usedBytes: { type: 'number' },
        },
        required: ['totalBytes', 'freeBytes', 'usedBytes'],
      },
      uptimeSeconds: { type: 'number' },
      nodeVersion: { type: 'string' },
      capturedAt: { type: 'string' },
    },
    required: [
      'platform',
      'architecture',
      'hostname',
      'operatingSystem',
      'cpuCount',
      'cpuModel',
      'memory',
      'uptimeSeconds',
      'nodeVersion',
      'capturedAt',
    ],
  },
  capabilities: [
    'system-information',
    'machine-diagnostics',
    'local-environment',
  ],
  supportedResourceKinds: ['system', 'device'],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'native.system',
};

export const systemMachineInfoImplementation: ToolImplementation = {
  toolId: systemMachineInfoTool.id,

  async execute() {
    const memoryTotal = os.totalmem();
    const memoryFree = os.freemem();

    const output = {
      platform: process.platform,
      architecture: process.arch,
      hostname: os.hostname(),
      operatingSystem: `${os.type()} ${os.release()}`,
      cpuCount: os.cpus().length,
      cpuModel: os.cpus()[0]?.model ?? 'unknown',
      memory: {
        totalBytes: memoryTotal,
        freeBytes: memoryFree,
        usedBytes: memoryTotal - memoryFree,
      },
      uptimeSeconds: os.uptime(),
      nodeVersion: process.version,
      capturedAt: new Date().toISOString(),
    };

    return {
      output,
      observations: [
        {
          id: `observation-${Date.now()}`,
          kind: 'system',
          source: 'native.system',
          subject: 'local-machine',
          summary: `Read information about ${output.hostname}.`,
          data: output,
          confidence: 1,
          observedAt: output.capturedAt,
          relatedResourceIds: [],
        },
      ],
    };
  },
};

export const systemProcessSummaryTool: ToolDescriptor = {
  id: 'system.process_summary',
  name: 'Process summary',
  description:
    'Reads read-only information about the current MARK process and system load without modifying anything.',
  version: '1.0.0',
  domain: 'system',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  outputSchema: {
    type: 'object',
    properties: {
      pid: { type: 'number' },
      uptimeSeconds: { type: 'number' },
      cpuCount: { type: 'number' },
      loadAverage: { type: 'array', items: { type: 'number' } },
      memoryBytes: {
        type: 'object',
        properties: {
          rss: { type: 'number' },
          heapTotal: { type: 'number' },
          heapUsed: { type: 'number' },
        },
        required: ['rss', 'heapTotal', 'heapUsed'],
      },
      capturedAt: { type: 'string' },
    },
    required: ['pid', 'uptimeSeconds', 'cpuCount', 'loadAverage', 'memoryBytes', 'capturedAt'],
  },
  capabilities: ['system-information', 'process-diagnostics', 'local-environment'],
  supportedResourceKinds: ['system', 'process'],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'native.system',
};

export const systemProcessSummaryImplementation: ToolImplementation = {
  toolId: systemProcessSummaryTool.id,

  async execute() {
    const memory = process.memoryUsage();
    const output = {
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      cpuCount: os.cpus().length,
      loadAverage: os.loadavg(),
      memoryBytes: {
        rss: memory.rss,
        heapTotal: memory.heapTotal,
        heapUsed: memory.heapUsed,
      },
      capturedAt: new Date().toISOString(),
    };

    return {
      output,
      observations: [
        {
          id: `observation-${Date.now()}`,
          kind: 'system',
          source: 'native.system',
          subject: 'local-process',
          summary: `Read process summary for pid ${output.pid}.`,
          data: output,
          confidence: 1,
          observedAt: output.capturedAt,
          relatedResourceIds: [],
        },
      ],
    };
  },
};

export const fsDirectoryListTool: ToolDescriptor = {
  id: 'fs.directory_list',
  name: 'Directory listing',
  description:
    'Lists entries of a local directory without modifying anything. Paths resolve inside the working directory or process cwd.',
  version: '1.0.0',
  domain: 'filesystem',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory to list. Defaults to the working directory.',
      },
      limit: {
        type: 'number',
        description: 'Maximum entries to return (1-50, default 20).',
      },
    },
    required: [],
  },
  outputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      count: { type: 'number' },
      truncated: { type: 'boolean' },
      entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            isDirectory: { type: 'boolean' },
            sizeBytes: { type: 'number' },
          },
          required: ['name', 'isDirectory', 'sizeBytes'],
        },
      },
      capturedAt: { type: 'string' },
    },
    required: ['path', 'count', 'truncated', 'entries', 'capturedAt'],
  },
  capabilities: ['filesystem-listing', 'local-environment'],
  supportedResourceKinds: ['directory', 'file'],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'native.system',
};

const DIRECTORY_LIST_LIMIT = 50;

export const fsDirectoryListImplementation: ToolImplementation = {
  toolId: fsDirectoryListTool.id,

  async execute({ action, context }) {
    const rawPath =
      typeof action.input.path === 'string' && action.input.path.length > 0
        ? String(action.input.path)
        : context.workingDirectory ?? process.cwd();
    const requestedLimit =
      typeof action.input.limit === 'number' ? Math.floor(action.input.limit) : 20;
    const limit = Math.min(Math.max(requestedLimit, 1), DIRECTORY_LIST_LIMIT);

    const base = path.resolve(context.workingDirectory ?? process.cwd());
    const resolved = path.resolve(base, rawPath);
    const names = await fs.readdir(resolved);
    const sliced = names.slice(0, limit);

    const entries: Array<{ name: string; isDirectory: boolean; sizeBytes: number }> = [];
    for (const name of sliced) {
      try {
        const stats = await fs.stat(path.join(resolved, name));
        entries.push({
          name,
          isDirectory: stats.isDirectory(),
          sizeBytes: stats.isFile() ? stats.size : 0,
        });
      } catch {
        entries.push({ name, isDirectory: false, sizeBytes: 0 });
      }
    }

    const output = {
      path: resolved,
      count: entries.length,
      truncated: names.length > entries.length,
      entries,
      capturedAt: new Date().toISOString(),
    };

    return {
      output,
      observations: [
        {
          id: `observation-${Date.now()}`,
          kind: 'file',
          source: 'native.system',
          subject: resolved,
          summary: `Listed ${entries.length} entries in ${resolved}.`,
          data: output,
          confidence: 1,
          observedAt: output.capturedAt,
          relatedResourceIds: [],
        },
      ],
    };
  },
};

const FILE_READ_MAX_BYTES = 20 * 1024;
const FILE_READ_MAX_LINES = 200;

const SENSITIVE_PATH_PATTERNS = [
  'shadow',
  'gshadow',
  '.ssh',
  'id_rsa',
  'id_ed25519',
  '.pem',
];

export const fsFileReadTool: ToolDescriptor = {
  id: 'fs.file_read',
  name: 'File read',
  description:
    'Reads a text file without modifying anything. Paths resolve inside the working directory. Sensitive credential paths are refused.',
  version: '1.0.0',
  domain: 'filesystem',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File to read, relative to the working directory or absolute.',
      },
      maxLines: {
        type: 'number',
        description: 'Maximum lines to return (1-200, default 50).',
      },
    },
    required: ['path'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      sizeBytes: { type: 'number' },
      truncated: { type: 'boolean' },
      lineCount: { type: 'number' },
      content: { type: 'string' },
      capturedAt: { type: 'string' },
    },
    required: ['path', 'sizeBytes', 'truncated', 'lineCount', 'content', 'capturedAt'],
  },
  capabilities: ['filesystem-reading', 'local-environment'],
  supportedResourceKinds: ['file'],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'native.system',
};

export const fsFileReadImplementation: ToolImplementation = {
  toolId: fsFileReadTool.id,

  async execute({ action, context }) {
    const rawPath = String(action.input.path ?? '');
    if (!rawPath) throw new Error('File path is required.');

    const lowered = rawPath.toLowerCase();
    if (SENSITIVE_PATH_PATTERNS.some(pattern => lowered.includes(pattern))) {
      throw new Error(`Refused: "${rawPath}" looks like a credential path.`);
    }

    const base = path.resolve(context.workingDirectory ?? process.cwd());
    const resolved = path.resolve(base, rawPath);
    const stats = await fs.stat(resolved);
    if (!stats.isFile()) throw new Error(`Not a file: "${resolved}".`);

    const maxLines =
      typeof action.input.maxLines === 'number'
        ? Math.min(Math.max(Math.floor(action.input.maxLines), 1), FILE_READ_MAX_LINES)
        : 50;

    const handle = await fs.open(resolved, 'r');
    try {
      const buffer = Buffer.alloc(FILE_READ_MAX_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, FILE_READ_MAX_BYTES, 0);
      const truncated = stats.size > bytesRead;
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      const lines = text.split('\n').slice(0, maxLines);
      const output = {
        path: resolved,
        sizeBytes: stats.size,
        truncated: truncated || text.split('\n').length > lines.length,
        lineCount: lines.length,
        content: lines.join('\n'),
        capturedAt: new Date().toISOString(),
      };
      return {
        output,
        observations: [
          {
            id: `observation-${Date.now()}`,
            kind: 'file',
            source: 'native.system',
            subject: resolved,
            summary: `Read ${lines.length} lines from ${resolved}.`,
            data: output,
            confidence: 1,
            observedAt: output.capturedAt,
            relatedResourceIds: [],
          },
        ],
      };
    } finally {
      await handle.close();
    }
  },
};

export const systemProcessListTool: ToolDescriptor = {
  id: 'system.process_list',
  name: 'Process list',
  description: 'Lists running processes without modifying anything.',
  version: '1.0.0',
  domain: 'system',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Maximum processes to return (1-100, default 20).',
      },
    },
    required: [],
  },
  outputSchema: {
    type: 'object',
    properties: {
      count: { type: 'number' },
      truncated: { type: 'boolean' },
      processes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            pid: { type: 'number' },
            name: { type: 'string' },
            cpuPercent: { type: 'number' },
            memoryPercent: { type: 'number' },
          },
          required: ['pid', 'name', 'cpuPercent', 'memoryPercent'],
        },
      },
      capturedAt: { type: 'string' },
    },
    required: ['count', 'truncated', 'processes', 'capturedAt'],
  },
  capabilities: ['system-information', 'process-diagnostics', 'local-environment'],
  supportedResourceKinds: ['process'],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'native.system',
};

export const systemProcessListImplementation: ToolImplementation = {
  toolId: systemProcessListTool.id,

  async execute({ action }) {
    const requested =
      typeof action.input.limit === 'number' ? Math.floor(action.input.limit) : 20;
    const limit = Math.min(Math.max(requested, 1), 100);

    // Fixed arguments only: no shell, no caller-controlled command string.
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid,comm,pcpu,pmem', '--no-headers'], {
      timeout: 10000,
    });
    const processes = stdout
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const [pidRaw, name, cpuRaw, memRaw] = line.split(/\s+/);
        return {
          pid: Number(pidRaw),
          name: name ?? '',
          cpuPercent: Number(cpuRaw),
          memoryPercent: Number(memRaw),
        };
      })
      .filter(entry => Number.isFinite(entry.pid) && entry.name)
      .slice(0, limit);

    const output = {
      count: processes.length,
      truncated: stdout.split('\n').filter(l => l.trim()).length > processes.length,
      processes,
      capturedAt: new Date().toISOString(),
    };
    return {
      output,
      observations: [
        {
          id: `observation-${Date.now()}`,
          kind: 'process',
          source: 'native.system',
          subject: 'local-processes',
          summary: `Listed ${processes.length} processes.`,
          data: output,
          confidence: 1,
          observedAt: output.capturedAt,
          relatedResourceIds: [],
        },
      ],
    };
  },
};

export const systemDiskUsageTool: ToolDescriptor = {
  id: 'system.disk_usage',
  name: 'Disk usage',
  description: 'Reports mounted filesystem usage without modifying anything.',
  version: '1.0.0',
  domain: 'system',
  risk: 'read',
  available: true,
  inputSchema: { type: 'object', properties: {}, required: [] },
  outputSchema: {
    type: 'object',
    properties: {
      mounts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            filesystem: { type: 'string' },
            sizeKB: { type: 'number' },
            usedKB: { type: 'number' },
            availableKB: { type: 'number' },
            usePercent: { type: 'number' },
            mount: { type: 'string' },
          },
          required: ['filesystem', 'sizeKB', 'usedKB', 'availableKB', 'usePercent', 'mount'],
        },
      },
      capturedAt: { type: 'string' },
    },
    required: ['mounts', 'capturedAt'],
  },
  capabilities: ['system-information', 'storage-diagnostics', 'local-environment'],
  supportedResourceKinds: ['system'],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'native.system',
};

export const systemDiskUsageImplementation: ToolImplementation = {
  toolId: systemDiskUsageTool.id,

  async execute() {
    const { stdout } = await execFileAsync('df', ['-kP'], { timeout: 10000 });
    const lines = stdout.split('\n').map(line => line.trim()).filter(Boolean).slice(1);
    const mounts = lines
      .map(line => {
        const [filesystem, sizeKB, usedKB, availableKB, usePct, mount] = line.split(/\s+/);
        return {
          filesystem,
          sizeKB: Number(sizeKB),
          usedKB: Number(usedKB),
          availableKB: Number(availableKB),
          usePercent: Number(String(usePct).replace('%', '')),
          mount,
        };
      })
      .filter(entry => entry.filesystem && entry.mount && Number.isFinite(entry.sizeKB));

    const output = { mounts, capturedAt: new Date().toISOString() };
    return {
      output,
      observations: [
        {
          id: `observation-${Date.now()}`,
          kind: 'system',
          source: 'native.system',
          subject: 'local-disks',
          summary: `Reported ${mounts.length} mounted filesystems.`,
          data: output,
          confidence: 1,
          observedAt: output.capturedAt,
          relatedResourceIds: [],
        },
      ],
    };
  },
};

export const netNetworkInterfacesTool: ToolDescriptor = {
  id: 'net.network_interfaces',
  name: 'Network interfaces',
  description: 'Lists local network interfaces without modifying anything.',
  version: '1.0.0',
  domain: 'network',
  risk: 'read',
  available: true,
  inputSchema: { type: 'object', properties: {}, required: [] },
  outputSchema: {
    type: 'object',
    properties: {
      interfaces: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            addresses: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  address: { type: 'string' },
                  family: { type: 'string' },
                  internal: { type: 'boolean' },
                },
                required: ['address', 'family', 'internal'],
              },
            },
          },
          required: ['name', 'addresses'],
        },
      },
      capturedAt: { type: 'string' },
    },
    required: ['interfaces', 'capturedAt'],
  },
  capabilities: ['network-information', 'local-environment'],
  supportedResourceKinds: ['network'],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'native.system',
};

export const netNetworkInterfacesImplementation: ToolImplementation = {
  toolId: netNetworkInterfacesTool.id,

  async execute() {
    const raw = os.networkInterfaces();
    const interfaces = Object.entries(raw).map(([name, entries]) => ({
      name,
      addresses: (entries ?? []).map(entry => ({
        address: entry.address,
        family: entry.family,
        internal: entry.internal,
      })),
    }));
    const output = { interfaces, capturedAt: new Date().toISOString() };
    return {
      output,
      observations: [
        {
          id: `observation-${Date.now()}`,
          kind: 'network',
          source: 'native.system',
          subject: 'local-network',
          summary: `Listed ${interfaces.length} network interfaces.`,
          data: output,
          confidence: 1,
          observedAt: output.capturedAt,
          relatedResourceIds: [],
        },
      ],
    };
  },
};

/**
 * Resolves a caller-supplied path inside the working-directory jail.
 * Throws when the resolved path escapes the jail.
 */
function resolveJailedPath(rawPath: string, workingDirectory: string | undefined): { base: string; resolved: string } {
  if (!rawPath) throw new Error('A path is required.');
  const base = path.resolve(workingDirectory ?? process.cwd());
  const resolved = path.resolve(base, rawPath);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Refused: "${rawPath}" escapes the working directory.`);
  }
  return { base, resolved };
}

const FILE_WRITE_MAX_BYTES = 50 * 1024;
const FILE_WRITE_SENSITIVE = [...SENSITIVE_PATH_PATTERNS, '.env'];

export const fsDirectoryCreateTool: ToolDescriptor = {
  id: 'fs.directory_create',
  name: 'Directory create',
  description:
    'Creates a directory inside the working directory without touching anything outside it. Fails when the directory already exists.',
  version: '1.0.0',
  domain: 'filesystem',
  risk: 'reversible',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory to create, relative to the working directory or absolute inside it.',
      },
    },
    required: ['path'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      created: { type: 'boolean' },
      capturedAt: { type: 'string' },
    },
    required: ['path', 'created', 'capturedAt'],
  },
  capabilities: ['filesystem-writing', 'local-environment'],
  supportedResourceKinds: ['directory'],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'native.system',
};

export const fsDirectoryCreateImplementation: ToolImplementation = {
  toolId: fsDirectoryCreateTool.id,

  async execute({ action, context }) {
    const { resolved } = resolveJailedPath(String(action.input.path ?? ''), context.workingDirectory);
    await fs.mkdir(resolved);
    const output = { path: resolved, created: true, capturedAt: new Date().toISOString() };
    return {
      output,
      observations: [
        {
          id: `observation-${Date.now()}`,
          kind: 'file',
          source: 'native.system',
          subject: resolved,
          summary: `Created directory ${resolved} (confirmation granted).`,
          data: output,
          confidence: 1,
          observedAt: output.capturedAt,
          relatedResourceIds: [],
        },
      ],
    };
  },
};

export const fsFileWriteTool: ToolDescriptor = {
  id: 'fs.file_write',
  name: 'File write',
  description:
    'Writes text content to a file inside the working directory. Refuses credential paths and never overwrites unless explicitly allowed.',
  version: '1.0.0',
  domain: 'filesystem',
  risk: 'mutating',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File to write, relative to the working directory or absolute inside it.',
      },
      content: { type: 'string', description: 'Text content to write (max 50KB).' },
      overwrite: { type: 'boolean', description: 'Allow overwriting an existing file (default false).' },
    },
    required: ['path', 'content'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      bytesWritten: { type: 'number' },
      overwritten: { type: 'boolean' },
      capturedAt: { type: 'string' },
    },
    required: ['path', 'bytesWritten', 'overwritten', 'capturedAt'],
  },
  capabilities: ['filesystem-writing', 'local-environment'],
  supportedResourceKinds: ['file'],
  requiredPermissions: [],
  reversible: false,
  metadata: {},
  provider: 'native.system',
};

export const fsFileWriteImplementation: ToolImplementation = {
  toolId: fsFileWriteTool.id,

  async execute({ action, context }) {
    const rawPath = String(action.input.path ?? '');
    const lowered = rawPath.toLowerCase();
    if (FILE_WRITE_SENSITIVE.some(pattern => lowered.includes(pattern))) {
      throw new Error(`Refused: "${rawPath}" looks like a credential path.`);
    }
    const { resolved } = resolveJailedPath(rawPath, context.workingDirectory);

    const content = String(action.input.content ?? '');
    if (Buffer.byteLength(content, 'utf8') > FILE_WRITE_MAX_BYTES) {
      throw new Error(`Refused: content exceeds ${FILE_WRITE_MAX_BYTES} bytes.`);
    }

    let existed = false;
    try {
      const stats = await fs.stat(resolved);
      existed = stats.isFile();
    } catch {
      existed = false;
    }
    if (existed && action.input.overwrite !== true) {
      throw new Error(`Refused: "${resolved}" exists and overwrite was not allowed.`);
    }

    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, 'utf8');
    const output = {
      path: resolved,
      bytesWritten: Buffer.byteLength(content, 'utf8'),
      overwritten: existed,
      capturedAt: new Date().toISOString(),
    };
    return {
      output,
      observations: [
        {
          id: `observation-${Date.now()}`,
          kind: 'file',
          source: 'native.system',
          subject: resolved,
          summary: `Wrote ${output.bytesWritten} bytes to ${resolved} (confirmation granted).`,
          data: output,
          confidence: 1,
          observedAt: output.capturedAt,
          relatedResourceIds: [],
        },
      ],
    };
  },
};

export const systemContainerRestartTool: ToolDescriptor = {
  id: 'system.container_restart',
  name: 'Container restart',
  description:
    'Restarts a Docker container by name. The container must be allowlisted by policy.',
  version: '1.0.0',
  domain: 'containers',
  risk: 'reversible',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      container: {
        type: 'string',
        description: 'Name of the container to restart.',
      },
    },
    required: ['container'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      container: { type: 'string' },
      restarted: { type: 'boolean' },
      detail: { type: 'string' },
      capturedAt: { type: 'string' },
    },
    required: ['container', 'restarted', 'detail', 'capturedAt'],
  },
  capabilities: ['container-restart', 'service-management'],
  supportedResourceKinds: ['service', 'application'],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'native.system',
};

export const CONTAINER_RESTART_PREFIX = 'container.restart.';

/**
 * POLICY (not a catalog): only these compose services may be restarted.
 * Which containers exist right now is discovered live from the daemon —
 * this list decides which of them MARK is allowed to touch.
 */
const CONTAINER_RESTART_ALLOWLIST = ['jarvis-db', 'jarvis-cache', 'jarvis-api'];

/** One restart tool per running container, generated from live daemon data. */
export function containerRestartTool(container: DockerContainer): ToolDescriptor {
  const serviceSuffix = container.service ? ` (compose service ${container.service})` : '';
  return {
    id: `${CONTAINER_RESTART_PREFIX}${container.name}`,
    name: `Restart ${container.name}`,
    description: `Restart the ${container.name} container (${container.image}${serviceSuffix}).`,
    version: '1.0.0',
    domain: 'containers',
    risk: 'reversible',
    available: true,
    inputSchema: { type: 'object', properties: {}, required: [] },
    outputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string' },
        restarted: { type: 'boolean' },
        detail: { type: 'string' },
        capturedAt: { type: 'string' },
      },
      required: ['container', 'restarted', 'detail', 'capturedAt'],
    },
    capabilities: [
      'container-restart',
      'service-management',
      ...(container.service ? [`service-${container.service}`] : []),
    ],
    supportedResourceKinds: ['service', 'application'],
    requiredPermissions: [],
    reversible: true,
    metadata: { container: container.name, image: container.image, service: container.service },
    provider: 'native.system',
  };
}

async function restartContainer(container: string): Promise<{ restarted: boolean; detail: string }> {
  if (!container) throw new Error('Refused: container name is required.');
  if (!CONTAINER_RESTART_ALLOWLIST.includes(container)) {
    throw new Error(
      `Refused by policy: "${container}" is not restartable (allowlisted: ${CONTAINER_RESTART_ALLOWLIST.join(', ')}).`,
    );
  }
  const { stdout, stderr } = await execFileAsync('docker', ['restart', container], { timeout: 30000 });
  return { restarted: true, detail: (stdout || stderr || 'Container restart completed.').trim() };
}

function containerRestartObservation(container: string, restarted: boolean, detail: string, capturedAt: string) {
  return {
    id: `observation-${Date.now()}`,
    kind: 'system' as const,
    source: 'native.system',
    subject: container,
    summary: `Restarted container ${container} (confirmation granted).`,
    data: { container, restarted, detail, capturedAt },
    confidence: 1,
    observedAt: capturedAt,
    relatedResourceIds: [],
  };
}

export const systemContainerRestartImplementation: ToolImplementation = {
  toolId: systemContainerRestartTool.id,

  async execute({ action }) {
    const container = String(action.input.container ?? '').trim();
    const { restarted, detail } = await restartContainer(container);
    const capturedAt = new Date().toISOString();
    const output = { container, restarted, detail, capturedAt };
    return {
      output,
      observations: [containerRestartObservation(container, restarted, detail, capturedAt)],
    };
  },
};

export const containerRestartFamilyImplementation: ToolImplementation = {
  toolId: CONTAINER_RESTART_PREFIX,

  async execute({ action }) {
    const container = String(action.toolId).slice(CONTAINER_RESTART_PREFIX.length);
    // Re-resolve against the live daemon: never restart from a stale catalog.
    const live = await listDockerContainers();
    if (!live.some(entry => entry.name === container)) {
      throw new Error(`Container "${container}" is not running (stale catalog entry; re-run discovery).`);
    }
    const { restarted, detail } = await restartContainer(container);
    const capturedAt = new Date().toISOString();
    const output = { container, restarted, detail, capturedAt };
    return {
      output,
      observations: [containerRestartObservation(container, restarted, detail, capturedAt)],
    };
  },
};

export const fsDirectorySizesTool: ToolDescriptor = {
  id: 'fs.directory_sizes',
  name: 'Directory sizes',
  description:
    'Reports the largest immediate subdirectories of a directory to find what is eating disk space.',
  version: '1.0.0',
  domain: 'filesystem',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory to measure. Defaults to the working directory.',
      },
      limit: {
        type: 'number',
        description: 'Maximum entries to return (1-50, default 20).',
      },
    },
    required: [],
  },
  outputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      count: { type: 'number' },
      truncated: { type: 'boolean' },
      entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            sizeKB: { type: 'number' },
          },
          required: ['path', 'sizeKB'],
        },
      },
      capturedAt: { type: 'string' },
    },
    required: ['path', 'count', 'truncated', 'entries', 'capturedAt'],
  },
  capabilities: ['storage-diagnostics', 'disk-usage', 'local-environment'],
  supportedResourceKinds: ['directory'],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'native.system',
};

export const fsDirectorySizesImplementation: ToolImplementation = {
  toolId: fsDirectorySizesTool.id,

  async execute({ action, context }) {
    // Sizes only, never contents: any absolute path is safe to measure.
    const rawPath =
      typeof action.input.path === 'string' && action.input.path.length > 0
        ? String(action.input.path)
        : context.workingDirectory ?? process.cwd();
    const requested = typeof action.input.limit === 'number' ? Math.floor(action.input.limit) : 20;
    const limit = Math.min(Math.max(requested, 1), 50);
    const resolved = path.resolve(rawPath);

    const names = (await fs.readdir(resolved)).slice(0, 200);
    const targets = names.map(name => path.join(resolved, name));
    // Fixed flags only; measured paths are operands, never a command string.
    const { stdout } = await execFileAsync('du', ['-sk', '-x', '--', ...targets], { timeout: 60000 });
    const entries = stdout
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const tab = line.indexOf('\t');
        return {
          path: tab >= 0 ? line.slice(tab + 1) : line,
          sizeKB: Number(tab >= 0 ? line.slice(0, tab) : NaN),
        };
      })
      .filter(entry => entry.path && Number.isFinite(entry.sizeKB))
      .sort((a, b) => b.sizeKB - a.sizeKB);
    const sliced = entries.slice(0, limit);

    const output = {
      path: resolved,
      count: sliced.length,
      truncated: entries.length > sliced.length,
      entries: sliced,
      capturedAt: new Date().toISOString(),
    };
    return {
      output,
      observations: [
        {
          id: `observation-${Date.now()}`,
          kind: 'file',
          source: 'native.system',
          subject: resolved,
          summary: `Measured ${entries.length} entries under ${resolved}; largest is ${sliced[0]?.path ?? 'unknown'} (${sliced[0]?.sizeKB ?? 0} KB).`,
          data: output,
          confidence: 1,
          observedAt: output.capturedAt,
          relatedResourceIds: [],
        },
      ],
    };
  },
};

export const systemContainerListTool: ToolDescriptor = {  id: 'system.container_list',
  name: 'Container list',
  description: 'Lists Docker containers and their status without modifying anything.',
  version: '1.0.0',
  domain: 'containers',
  risk: 'read',
  available: true,
  inputSchema: { type: 'object', properties: {}, required: [] },
  outputSchema: {
    type: 'object',
    properties: {
      count: { type: 'number' },
      containers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            status: { type: 'string' },
            image: { type: 'string' },
            service: { type: 'string' },
          },
          required: ['name', 'status', 'image'],
        },
      },
      capturedAt: { type: 'string' },
    },
    required: ['count', 'containers', 'capturedAt'],
  },
  capabilities: ['container-listing', 'service-management'],
  supportedResourceKinds: ['service', 'application'],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'native.system',
};

export interface DockerContainer {
  name: string;
  status: string;
  image: string;
  service?: string;
}

/** Live container inventory. Throws when the Docker daemon is unreachable. */
export async function listDockerContainers(): Promise<DockerContainer[]> {
  // Fixed arguments only: no shell, no caller-controlled command string.
  const { stdout } = await execFileAsync(
    'docker',
    ['ps', '--format', '{{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Label "com.docker.compose.service"}}'],
    { timeout: 15000 },
  );
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [name, status, image, service] = line.split('\t');
      return {
        name: name ?? '',
        status: status ?? '',
        image: image ?? '',
        service: service?.trim() ? service.trim() : undefined,
      };
    })
    .filter(entry => entry.name);
}

export const systemContainerListImplementation: ToolImplementation = {
  toolId: systemContainerListTool.id,

  async execute() {
    const containers = await listDockerContainers();
    const output = { count: containers.length, containers, capturedAt: new Date().toISOString() };
    return {
      output,
      observations: [
        {
          id: `observation-${Date.now()}`,
          kind: 'system',
          source: 'native.system',
          subject: 'local-containers',
          summary: `Listed ${containers.length} containers.`,
          data: output,
          confidence: 1,
          observedAt: output.capturedAt,
          relatedResourceIds: [],
        },
      ],
    };
  },
};

export const nativeSystemTools: ToolDescriptor[] = [
  systemMachineInfoTool,
  systemProcessSummaryTool,
  fsDirectoryListTool,
  fsFileReadTool,
  systemProcessListTool,
  systemDiskUsageTool,
  netNetworkInterfacesTool,
  fsDirectoryCreateTool,
  fsFileWriteTool,
  systemContainerRestartTool,
  systemContainerListTool,
  fsDirectorySizesTool,
];

export const nativeSystemImplementations: ToolImplementation[] = [
  systemMachineInfoImplementation,
  systemProcessSummaryImplementation,
  fsDirectoryListImplementation,
  fsFileReadImplementation,
  systemProcessListImplementation,
  systemDiskUsageImplementation,
  netNetworkInterfacesImplementation,
  fsDirectoryCreateImplementation,
  fsFileWriteImplementation,
  systemContainerRestartImplementation,
  systemContainerListImplementation,
  fsDirectorySizesImplementation,
];

export const nativeSystemDiscoveryProvider: DiscoveryProvider = {
  id: 'native.system',
  name: 'Native system provider',
  description:
    'Provides safe, read-only information about the local operating system and machine.',
  priority: 100,

  async isAvailable(): Promise<boolean> {
    return true;
  },

  async discoverResources(): Promise<ResourceDescriptor[]> {
    return [
      {
        id: 'local-machine',
        kind: 'system',
        name: os.hostname(),
        state: 'available',
        provider: 'native.system',
        capabilities: ['system-information', 'machine-diagnostics'],
        discoveredAt: new Date().toISOString(),
        metadata: {
          platform: process.platform,
          architecture: process.arch,
        },
      },
    ];
  },

  async discoverTools(): Promise<ToolDescriptor[]> {
    let perContainer: ToolDescriptor[] = [];
    try {
      perContainer = (await listDockerContainers()).map(containerRestartTool);
    } catch {
      perContainer = []; // daemon unreachable: static tools only
    }
    return [...nativeSystemTools, ...perContainer];
  },
};
