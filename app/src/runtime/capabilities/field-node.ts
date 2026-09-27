import { Capability } from './registry';

/**
 * Phase 1 of the mark-runtime merge: field nodes + probe.
 *
 * A field node is any host running mark-runtime's `host-probe.py` (laptop,
 * Pi, robot PC). Its manifest mirrors `mark-runtime/host-manifest.json`:
 * cameras, audio, tools, models_local, gpio, i2c, serial.
 * ESP32/Arduino nodes never run the probe; they register via MQTT with a
 * minimal manifest instead (Phase 3).
 */
export interface FieldManifest {
  hostname: string;
  cameras?: string[];
  audio?: boolean;
  tools?: Record<string, string>;
  models_local?: string[];
  gpio?: boolean;
  i2c?: boolean;
  serial?: string[];
}

interface FieldNode {
  manifest: FieldManifest;
  lastSeen: Date;
}

export class FieldNodeRegistry {
  private readonly nodes = new Map<string, FieldNode>();

  register(manifest: FieldManifest): void {
    this.nodes.set(manifest.hostname, { manifest, lastSeen: new Date() });
  }

  /** Hostnames whose manifest satisfies every requested key. */
  match(wants: { camera?: boolean; gpio?: boolean; tool?: string; model?: boolean }): string[] {
    return Array.from(this.nodes.values())
      .filter(({ manifest }) => {
        if (wants.camera && !(manifest.cameras && manifest.cameras.length > 0)) return false;
        if (wants.gpio && !manifest.gpio) return false;
        if (wants.tool && !(manifest.tools && manifest.tools[wants.tool])) return false;
        if (wants.model && !(manifest.models_local && manifest.models_local.length > 0)) return false;
        return true;
      })
      .map(({ manifest }) => manifest.hostname);
  }

  list(): string[] {
    return Array.from(this.nodes.keys());
  }
}

export const fieldNodeRegistry = new FieldNodeRegistry();

/**
 * Answers "which nodes can do X?" so the task-binder routes
 * capability-constrained work to the right host.
 */
export class FieldProbeCapability implements Capability {
  id = 'field.probe';
  name = 'Field node capability probe';

  canHandle(input: string): boolean {
    return /\b(which nodes|which hosts|field nodes|has (a )?camera|has gpio|can (do|handle)|route to)\b/i.test(input);
  }

  async execute(input: string): Promise<string> {
    const nodes = fieldNodeRegistry.list();
    if (nodes.length === 0) {
      return 'No field nodes registered. Run mark-runtime setup.sh on the host first.';
    }
    const lines = nodes.map(hostname => {
      const withCam = fieldNodeRegistry.match({ camera: true }).includes(hostname) ? 'camera ' : '';
      const withGpio = fieldNodeRegistry.match({ gpio: true }).includes(hostname) ? 'gpio ' : '';
      return `- ${hostname} [${(withCam + withGpio).trim() || 'basic'}]`;
    });
    void input;
    return `Field nodes (${nodes.length}):\n${lines.join('\n')}`;
  }
}
