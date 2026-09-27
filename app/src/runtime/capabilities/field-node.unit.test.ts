/** Phase 1 merge proof: field node registry matching (no voice). */
import { describe, it, expect } from 'vitest';
import { FieldNodeRegistry, FieldProbeCapability } from './field-node.js';

describe('field-node registry', () => {
  it('matches nodes by capability', () => {
    const reg = new FieldNodeRegistry();
    reg.register({ hostname: 'kali23', cameras: ['/dev/video0'], gpio: true });
    reg.register({ hostname: 'pi-door', gpio: false });
    expect(reg.match({ camera: true })).toEqual(['kali23']);
    expect(reg.match({ gpio: true })).toEqual(['kali23']);
    expect(reg.list().sort()).toEqual(['kali23', 'pi-door']);
  });

  it('probe answers with registered nodes', async () => {
    const { fieldNodeRegistry } = await import('./field-node.js');
    fieldNodeRegistry.register({ hostname: 'kali23-test', cameras: ['/dev/video0'] });
    const cap = new FieldProbeCapability();
    expect(cap.canHandle('which nodes have a camera?')).toBe(true);
    const out = await cap.execute('which nodes have a camera?');
    expect(out).toMatch(/kali23-test/);
  });
});
