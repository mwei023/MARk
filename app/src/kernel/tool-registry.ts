import {
  KernelId,
  ToolDescriptor,
} from './types';

/**
 * Stores the tools currently known to MARK.
 *
 * The registry describes tools; it does not execute them.
 * Execution belongs to the executor.
 */
export class ToolRegistry {
  private readonly tools = new Map<KernelId, ToolDescriptor>();

  register(tool: ToolDescriptor): void {
    this.tools.set(tool.id, tool);
  }

  registerMany(tools: ToolDescriptor[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  unregister(toolId: KernelId): boolean {
    return this.tools.delete(toolId);
  }

  get(toolId: KernelId): ToolDescriptor | undefined {
    return this.tools.get(toolId);
  }

  has(toolId: KernelId): boolean {
    return this.tools.has(toolId);
  }

  list(): ToolDescriptor[] {
    return Array.from(this.tools.values());
  }

  listAvailable(): ToolDescriptor[] {
    return this.list().filter(tool => tool.available);
  }

  findByDomain(domain: string): ToolDescriptor[] {
    const normalizedDomain = domain.trim().toLowerCase();

    return this.list().filter(
      tool => tool.domain.toLowerCase() === normalizedDomain,
    );
  }

  findByResourceKind(
    resourceKind: ToolDescriptor['supportedResourceKinds'][number],
  ): ToolDescriptor[] {
    return this.list().filter(tool =>
      tool.supportedResourceKinds.includes(resourceKind),
    );
  }

  search(query: string): ToolDescriptor[] {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .map(term => term.trim())
      .filter(Boolean);

    if (terms.length === 0) {
      return [];
    }

    return this.list().filter(tool => {
      const searchableText = [
        tool.id,
        tool.name,
        tool.description,
        tool.domain,
        tool.provider,
        ...tool.requiredPermissions,
        ...tool.supportedResourceKinds,
      ]
        .join(' ')
        .toLowerCase();

      return terms.every(term => searchableText.includes(term));
    });
  }

  clear(): void {
    this.tools.clear();
  }
}

export const toolRegistry = new ToolRegistry();
