export interface Capability {
  id: string;
  name: string;
  provides: string[];
  execute(method: string, args: any): Promise<any>;
}
export const capabilities = new Map<string, Capability>();
export function register(cap: Capability) { capabilities.set(cap.id, cap); }
export function find(method: string) { return Array.from(capabilities.values()).filter(c => c.provides.includes(method)); }
