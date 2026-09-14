import os from 'node:os';

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
  capabilities: [
    'system-information',
    'machine-diagnostics',
    'local-environment',
  ],
  resourceKinds: ['system', 'device'],
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

export const nativeSystemTools: ToolDescriptor[] = [
  systemMachineInfoTool,
];

export const nativeSystemImplementations: ToolImplementation[] = [
  systemMachineInfoImplementation,
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
