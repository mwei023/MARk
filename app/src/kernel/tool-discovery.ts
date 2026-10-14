import {
  ResourceDescriptor,
  ToolDescriptor,
} from './types';

/**
 * A source capable of discovering resources and tools available to MARK.
 *
 * Examples of future providers:
 * - Linux host integration
 * - Windows host integration
 * - browser integration
 * - MCP provider
 * - installed-application provider
 * - remote-machine provider
 * - user-defined extension
 */
export interface DiscoveryProvider {
  id: string;
  name: string;
  description: string;
  priority?: number;
  isAvailable(): Promise<boolean>;
  discoverResources(): Promise<ResourceDescriptor[]>;
  discoverTools(): Promise<ToolDescriptor[]>;
}

export interface DiscoveryResult {
  providerId: string;
  resources: ResourceDescriptor[];
  tools: ToolDescriptor[];
  discoveredAt: string;
  warnings: string[];
  errors: string[];
}

export class ToolDiscovery {
  private readonly providers = new Map<string, DiscoveryProvider>();

  registerProvider(provider: DiscoveryProvider): void {
    this.providers.set(provider.id, provider);
  }

  unregisterProvider(providerId: string): boolean {
    return this.providers.delete(providerId);
  }

  getProvider(providerId: string): DiscoveryProvider | undefined {
    return this.providers.get(providerId);
  }

  listProviders(): DiscoveryProvider[] {
    return Array.from(this.providers.values()).sort(
      (left, right) => (right.priority ?? 0) - (left.priority ?? 0),
    );
  }

  async discoverFrom(
    provider: DiscoveryProvider,
  ): Promise<DiscoveryResult> {
    const discoveredAt = new Date().toISOString();
    const warnings: string[] = [];
    const errors: string[] = [];

    let resources: ResourceDescriptor[] = [];
    let tools: ToolDescriptor[] = [];

    try {
      const available = await provider.isAvailable();

      if (!available) {
        warnings.push(`Provider "${provider.id}" is unavailable.`);
        return {
          providerId: provider.id,
          resources,
          tools,
          discoveredAt,
          warnings,
          errors,
        };
      }
    } catch (error) {
      errors.push(
        `Could not check provider "${provider.id}": ${this.describeError(error)}`,
      );

      return {
        providerId: provider.id,
        resources,
        tools,
        discoveredAt,
        warnings,
        errors,
      };
    }

    try {
      resources = await provider.discoverResources();
    } catch (error) {
      errors.push(
        `Resource discovery failed for "${provider.id}": ${this.describeError(error)}`,
      );
    }

    try {
      tools = await provider.discoverTools();
    } catch (error) {
      errors.push(
        `Tool discovery failed for "${provider.id}": ${this.describeError(error)}`,
      );
    }

    return {
      providerId: provider.id,
      resources,
      tools,
      discoveredAt,
      warnings,
      errors,
    };
  }

  async discoverAll(): Promise<DiscoveryResult[]> {
    const results: DiscoveryResult[] = [];

    for (const provider of this.listProviders()) {
      results.push(await this.discoverFrom(provider));
    }

    return results;
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}

export const toolDiscovery = new ToolDiscovery();
