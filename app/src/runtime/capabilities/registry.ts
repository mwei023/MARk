/**
 * Concrete host operation exposed to MARK.
 *
 * Agents coordinate behaviour; capabilities perform the actual host work.  This
 * small registry is the single capability registry used by the Phase 1 runtime.
 */
export interface Capability {
  id: string;
  name: string;
  canHandle(input: string): boolean;
  execute(input: string): Promise<string>;
}

export class CapabilityRegistry {
  private readonly capabilities = new Map<string, Capability>();

  register(capability: Capability): void {
    this.capabilities.set(capability.id, capability);
  }

  findFor(input: string): Capability | undefined {
    return Array.from(this.capabilities.values()).find(capability => capability.canHandle(input));
  }

  async execute(input: string): Promise<string | undefined> {
    const capability = this.findFor(input);
    return capability ? capability.execute(input) : undefined;
  }

  list(): Capability[] {
    return Array.from(this.capabilities.values());
  }
}

export const capabilityRegistry = new CapabilityRegistry();
