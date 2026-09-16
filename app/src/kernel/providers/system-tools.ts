import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

export const nativeSystemTools: ToolDescriptor[] = [
  systemMachineInfoTool,
  systemProcessSummaryTool,
  fsDirectoryListTool,
];

export const nativeSystemImplementations: ToolImplementation[] = [
  systemMachineInfoImplementation,
  systemProcessSummaryImplementation,
  fsDirectoryListImplementation,
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
