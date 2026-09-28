import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../../config.js';

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

export const fsFileSearchTool: ToolDescriptor = {
  id: 'fs.file_search',
  name: 'File search',
  description:
    'Finds text in file contents under a directory (searches for a pattern). Skips node_modules and .git. Read-only; patterns are operands, never shell.',
  version: '1.0.0',
  domain: 'filesystem',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory to search. Defaults to the working directory.',
      },
      pattern: {
        type: 'string',
        description: 'Fixed text to search for (not a regex).',
      },
      include: {
        type: 'string',
        description: 'Filename glob, e.g. "*.ts" (default: all files).',
      },
      limit: {
        type: 'number',
        description: 'Maximum matches to return (1-50, default 20).',
      },
    },
    required: ['pattern'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      pattern: { type: 'string' },
      count: { type: 'number' },
      truncated: { type: 'boolean' },
      matches: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            line: { type: 'number' },
            preview: { type: 'string' },
          },
          required: ['file', 'line', 'preview'],
        },
      },
      capturedAt: { type: 'string' },
    },
    required: ['path', 'pattern', 'count', 'truncated', 'matches', 'capturedAt'],
  },
  capabilities: ['filesystem-search', 'code-search', 'local-environment'],
  supportedResourceKinds: ['file', 'directory'],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'native.system',
};

const FILE_SEARCH_LIMIT = 50;

export const fsFileSearchImplementation: ToolImplementation = {
  toolId: fsFileSearchTool.id,

  async execute({ action, context }) {
    const pattern = String(action.input.pattern ?? '');
    if (!pattern) throw new Error('Search pattern is required.');
    if (pattern.length > 200) throw new Error('Search pattern too long (max 200 chars).');

    const rawPath =
      typeof action.input.path === 'string' && action.input.path.length > 0
        ? String(action.input.path)
        : context.workingDirectory ?? process.cwd();
    const requestedLimit =
      typeof action.input.limit === 'number' ? Math.floor(action.input.limit) : 20;
    const limit = Math.min(Math.max(requestedLimit, 1), FILE_SEARCH_LIMIT);

    const base = path.resolve(context.workingDirectory ?? process.cwd());
    const resolved = path.resolve(base, rawPath);
    const stats = await fs.stat(resolved);
    if (!stats.isDirectory()) throw new Error(`Not a directory: "${resolved}".`);

    const include = typeof action.input.include === 'string' && action.input.include.length > 0
      ? String(action.input.include)
      : null;

    // Fixed flags only; the pattern travels as an operand after `--`,
    // never through a shell. grep exits 1 on no matches: that is an
    // empty result, not a failure.
    const args = ['-r', '-n', '-I', '-m', '3', '--exclude-dir=node_modules', '--exclude-dir=.git'];
    if (include) args.push(`--include=${include}`);
    args.push('--', pattern, resolved);

    let stdout = '';
    try {
      ({ stdout } = await execFileAsync('grep', args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }));
    } catch (error: any) {
      if (Number((error as any)?.code) === 1) {
        stdout = '';
      } else {
        throw new Error(`Search failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const matches = stdout
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const first = line.indexOf(':');
        const second = line.indexOf(':', first + 1);
        if (first < 0 || second < 0) return null;
        return {
          file: line.slice(0, first),
          line: Number(line.slice(first + 1, second)) || 0,
          preview: line.slice(second + 1, second + 201),
        };
      })
      .filter((entry): entry is { file: string; line: number; preview: string } => entry !== null)
      .slice(0, limit + 1);
    const truncated = matches.length > limit;
    const sliced = matches.slice(0, limit);

    const output = {
      path: resolved,
      pattern,
      count: sliced.length,
      truncated,
      matches: sliced,
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
          summary: `Searched "${pattern}" under ${resolved}: ${sliced.length} match(es).`,
          data: output,
          confidence: 1,
          observedAt: output.capturedAt,
          relatedResourceIds: [],
        },
      ],
    };
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
 * Throws when the resolved path escapes the jail — unless MARK_TEST_MODE
 * is set, which bypasses the check with a loud warning (testing only,
 * reversible via env var).
 */
function resolveJailedPath(rawPath: string, workingDirectory: string | undefined): { base: string; resolved: string } {
  if (!rawPath) throw new Error('A path is required.');
  const base = path.resolve(workingDirectory ?? process.cwd());
  const resolved = path.resolve(base, rawPath);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    if (config.markTestMode) {
      console.warn(`[kernel] MARK_TEST_MODE: jail bypass for "${rawPath}" (base ${base})`);
      return { base, resolved };
    }
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
    'Creates a directory inside the working directory without touching anything outside it, creating missing parents as needed. Fails when the directory already exists.',
  version: '1.1.0',
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
    try {
      const stats = await fs.stat(resolved);
      if (stats.isDirectory()) {
        const output = { path: resolved, created: false, capturedAt: new Date().toISOString() };
        return { output };
      }
    } catch {
      // Missing — create below, including parents.
    }
    await fs.mkdir(resolved, { recursive: true });
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

  async verify({ output }) {
    const dir = String((output as any)?.path ?? '');
    if (!dir) return { ok: false, detail: 'no directory path in output to verify' };
    try {
      const stats = await fs.stat(dir);
      if (!stats.isDirectory()) return { ok: false, detail: `"${dir}" exists but is not a directory` };
      return { ok: true, detail: `directory "${dir}" exists` };
    } catch {
      return { ok: false, detail: `directory "${dir}" missing after creation` };
    }
  },
};

export const fsFileWriteTool: ToolDescriptor = {
  id: 'fs.file_write',
  name: 'File write',
  description:
    'Writes text content to a file inside the working directory. Refuses credential paths and never overwrites unless explicitly allowed. Appends instead of replacing when append is true.',
  version: '1.1.0',
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
      append: { type: 'boolean', description: 'Append to an existing file instead of replacing it (default false).' },
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

    // Payloads often arrive with literal escape sequences (binder passes
    // `content: "<html>"` through verbatim, LLM drafts come JSON-quoted).
    // When the value has no real newlines but carries `\n` literals, decode
    // the common escapes so files land as authored, not escaped. Observed
    // live: index.html written with literal \n and \" sequences.
    let content = String(action.input.content ?? '');
    if (!content.includes('\n') && /\\n/.test(content)) {
      content = content
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\r/g, '\r')
        .replace(/\\"/g, '"');
    }
    // Drop a leading language tag line ("html") some models prepend despite
    // "code only" instructions.
    content = content.replace(/^(html|css|javascript|js|typescript|ts)\n/i, '');
    if (Buffer.byteLength(content, 'utf8') > FILE_WRITE_MAX_BYTES) {
      throw new Error(`Refused: content exceeds ${FILE_WRITE_MAX_BYTES} bytes.`);
    }

    let existed = false;
    let sizeBefore = 0;
    try {
      const stats = await fs.stat(resolved);
      existed = stats.isFile();
      sizeBefore = stats.size;
    } catch {
      existed = false;
    }
    if (existed && action.input.overwrite !== true && action.input.append !== true) {
      throw new Error(`Refused: "${resolved}" exists and overwrite was not allowed.`);
    }

    await fs.mkdir(path.dirname(resolved), { recursive: true });
    if (existed && action.input.append === true) {
      await fs.appendFile(resolved, content, 'utf8');
    } else {
      await fs.writeFile(resolved, content, 'utf8');
    }
    const output = {
      path: resolved,
      bytesWritten: Buffer.byteLength(content, 'utf8'),
      overwritten: existed && action.input.append !== true,
      appended: existed && action.input.append === true,
      sizeBefore: existed ? sizeBefore : 0,
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

  async verify({ output }) {
    const file = String((output as any)?.path ?? '');
    const expectedBytes = Number((output as any)?.bytesWritten ?? NaN);
    const sizeBefore = Number((output as any)?.sizeBefore ?? 0);
    if (!file) return { ok: false, detail: 'no file path in output to verify' };
    try {
      const stats = await fs.stat(file);
      if (!stats.isFile()) return { ok: false, detail: `"${file}" exists but is not a file` };
      const expected = (output as any)?.appended === true ? sizeBefore + expectedBytes : expectedBytes;
      if (Number.isFinite(expected) && stats.size !== expected) {
        return { ok: false, detail: `"${file}" is ${stats.size} bytes, expected ${expected}` };
      }
      return { ok: true, detail: `file "${file}" exists (${stats.size} bytes)` };
    } catch {
      return { ok: false, detail: `file "${file}" missing after write` };
    }
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

  async verify({ output }) {
    return verifyContainerRunning(String((output as any)?.container ?? ''));
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

  async verify({ output }) {
    return verifyContainerRunning(String((output as any)?.container ?? ''));
  },
};

/** Independent check: is the container actually up after the restart? */
async function verifyContainerRunning(container: string): Promise<{ ok: boolean; detail: string }> {
  if (!container) return { ok: false, detail: 'no container name in output to verify' };
  try {
    const live = await listDockerContainers();
    const entry = live.find(item => item.name === container);
    if (!entry) return { ok: false, detail: `container "${container}" not running after restart` };
    return { ok: true, detail: `container "${container}" running (${entry.status})` };
  } catch (error) {
    return { ok: false, detail: `could not verify "${container}": ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Measures paths with du. Fixed flags only; paths are operands, never a command string. */
async function duSizes(targets: string[]): Promise<Array<{ path: string; sizeKB: number }>> {
  const { stdout } = await execFileAsync('du', ['-sk', '-x', '--', ...targets], { timeout: 60000 });
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const tab = line.indexOf('\t');
      return {
        path: tab >= 0 ? line.slice(tab + 1) : line,
        sizeKB: Number(tab >= 0 ? line.slice(0, tab).trim() : NaN),
      };
    })
    .filter(entry => entry.path && Number.isFinite(entry.sizeKB));
}

export const fsDirectorySizesTool: ToolDescriptor = {  id: 'fs.directory_sizes',
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
        description: 'Directory to measure. Defaults to / (the whole disk).',
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

  async execute({ action }) {
    // Sizes only, never contents: any absolute path is safe to measure.
    // Default is the filesystem root — this tool answers "what is eating
    // my disk", not "what is in this folder" (that is directory_list).
    const rawPath =
      typeof action.input.path === 'string' && action.input.path.length > 0
        ? String(action.input.path)
        : '/';
    const requested = typeof action.input.limit === 'number' ? Math.floor(action.input.limit) : 20;
    const limit = Math.min(Math.max(requested, 1), 50);
    const resolved = path.resolve(rawPath);

    const names = (await fs.readdir(resolved)).slice(0, 200);
    const targets = names.map(name => path.join(resolved, name));
    // One combined du is fast (a 99%-full disk took 41s as 20 spawns);
    // virtual filesystems (/proc, /sys) make combined du exit non-zero, so
    // per-child failures are skipped individually on fallback, not fatal.
    let measured: Array<{ path: string; sizeKB: number }>;
    try {
      measured = await duSizes(targets);
    } catch {
      measured = [];
      for (const target of targets) {
        try {
          measured.push(...(await duSizes([target])));
        } catch {
          continue;
        }
      }
    }
    const entries = measured.sort((a, b) => b.sizeKB - a.sizeKB);
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
  fsFileSearchTool,
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
  fsFileSearchImplementation,
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
