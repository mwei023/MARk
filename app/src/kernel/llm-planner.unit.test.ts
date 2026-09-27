import { describe, it, expect } from 'vitest';
import { proposePlanWithLLM, sanitizeInputValue } from './llm-planner.js';
import { ToolRegistry } from './tool-registry.js';
import { KernelPlanner } from './planner.js';
import type { ToolDescriptor } from './types.js';
import type { LLMProvider, Message } from '../llm/index.js';
const openTool: ToolDescriptor = {
  id: 'browser.open',
  name: 'Open URL',
  description: 'Opens an http(s) URL in the browser.',
  version: '1.0.0',
  domain: 'browser',
  risk: 'reversible',
  available: true,
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string', description: 'http(s) URL to open.' } },
    required: ['url'],
  },
  capabilities: ['browser-launch'],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'test',
};

function fakeProvider(content: string): LLMProvider {
  return {
    chat: async (_messages: Message[]) => ({ content, model: 'fake', provider: 'fake' }),
    getMetadata: () => ({ provider: 'fake', model: 'fake', status: 'available' as const }),
    isAvailable: async () => true,
  } as unknown as LLMProvider;
}

describe('planner input starvation guard', () => {
  it('strips one layer of surrounding quotes from string values', () => {
    expect(sanitizeInputValue('"http://localhost:8099/index.html"')).toBe('http://localhost:8099/index.html');
    expect(sanitizeInputValue("'mark-os-site'")).toBe('mark-os-site');
    expect(sanitizeInputValue('  plain  ')).toBe('plain');
    expect(sanitizeInputValue(42)).toBe(42);
    expect(sanitizeInputValue(undefined)).toBe(undefined);
  });

  it('quoted url in an LLM proposal reaches the plan unquoted and valid', async () => {
    const registry = new ToolRegistry();
    registry.register(openTool);
    const planner = new KernelPlanner({});
    const validate = (plan: Parameters<KernelPlanner['validate']>[0]) => planner.validate(plan, registry);
    const proposal = JSON.stringify({
      steps: [{ toolId: 'browser.open', input: { url: '"http://localhost:8099/index.html"' }, dependsOn: [] }],
      successCriteria: ['browser opens the page'],
    });
    const result = await proposePlanWithLLM(
      'Open browser with url: http://localhost:8099/index.html',
      [openTool],
      validate,
      { provider: fakeProvider(proposal), timeoutMs: 5000, maxAttempts: 1 },
    );
    expect(result).toBeDefined();
    expect(result!.validation.valid).toBe(true);
    const url = (result!.plan.steps[0].input as Record<string, unknown>).url;
    expect(url).toBe('http://localhost:8099/index.html');
    expect(() => new URL(String(url))).not.toThrow();
  });
});

describe('planComposed goal-bound values win', () => {
  const searchTool: ToolDescriptor = {
    id: 'test.search',
    name: 'Search',
    description: 'Searches and returns query echo plus results.',
    version: '1.0.0',
    domain: 'test',
    risk: 'read',
    available: true,
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query.' } },
      required: ['query'],
    },
    outputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, results: { type: 'string' } },
      required: ['query', 'results'],
    },
    capabilities: [],
    supportedResourceKinds: [],
    requiredPermissions: [],
    reversible: true,
    metadata: {},
    provider: 'test',
  };
  const openTool2: ToolDescriptor = {
    id: 'test.open',
    name: 'Open',
    description: 'Opens a URL target.',
    version: '1.0.0',
    domain: 'test',
    risk: 'reversible',
    available: true,
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL target to open.' } },
      required: ['url'],
    },
    outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    capabilities: [],
    supportedResourceKinds: [],
    requiredPermissions: [],
    reversible: true,
    metadata: {},
    provider: 'test',
  };

  it('explicit url runs single-step without a producer reference', () => {
    const planner = new KernelPlanner([searchTool, openTool2]);
    const plan = planner.planComposed('Open browser with url: http://localhost:8099/index.html');
    expect(plan.steps.length).toBe(1);
    expect(plan.steps[0].toolId).toBe('test.open');
    expect((plan.steps[0].input as Record<string, unknown>).url).toBe('http://localhost:8099/index.html');
  });
});
