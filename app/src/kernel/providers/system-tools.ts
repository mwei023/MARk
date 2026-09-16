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

export const nativeSystemTools: ToolDescriptor[] = [
  systemMachineInfoTool,
  systemProcessSummaryTool,
  fsDirectoryListTool,
  fsFileReadTool,
  systemProcessListTool,
  systemDiskUsageTool,
  netNetworkInterfacesTool,
];

export const nativeSystemImplementations: ToolImplementation[] = [
  systemMachineInfoImplementation,
  systemProcessSummaryImplementation,
  fsDirectoryListImplementation,
  fsFileReadImplementation,
  systemProcessListImplementation,
  systemDiskUsageImplementation,
  netNetworkInterfacesImplementation,
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
    return nativeSystemTools;
  },
};
