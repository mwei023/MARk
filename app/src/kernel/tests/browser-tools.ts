import assert from 'node:assert/strict';
import http from 'node:http';

import { MARKKernel } from '../index';
import { registerNativeSystemProvider } from '../providers/register-native';

async function main(): Promise<void> {
  const kernel = new MARKKernel();
  registerNativeSystemProvider(kernel);
  await kernel.discover();

  assert.ok(kernel.listTools().some(t => t.id === 'browser.read'), 'browser.read discovered');
  assert.ok(kernel.listTools().some(t => t.id === 'browser.open'), 'browser.open discovered');

  const server = http.createServer((req, res) => {
    if (req.url === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><head><title>Test Page</title><script>evil()</script><style>.x{}</style></head><body><h1>Hello MARK</h1><p>Readable content here.</p></body></html>`);
    } else if (req.url === '/binary') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('missing');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;

  const context = (profile = 'default') =>
    kernel.createContext({ userId: 'browser-test', authorityProfile: profile, source: 'system', metadata: {} });
  const action = (id: string, toolId: string, input: Record<string, unknown>) => ({
    id,
    toolId,
    input,
    requestedBy: 'browser-test',
    createdAt: new Date().toISOString(),
  });

  async function confirmedRun(id: string, toolId: string, input: Record<string, unknown>) {
    const workspace = context('workspace');
    const blocked = await kernel.execute(action(`${id}-ask`, toolId, input), workspace);
    assert.equal(blocked.status, 'blocked');
    const confirmationId = String((blocked.metadata as any)?.confirmationId ?? '');
    assert.ok(confirmationId);
    kernel.resolveConfirmation(confirmationId, true);
    return kernel.executeConfirmed(action(id, toolId, input), workspace, confirmationId);
  }

  try {
    // A. Reads text, strips scripts/styles, captures title.
    const read = await kernel.execute(action('b-1', 'browser.read', { url: `${base}/page` }), context());
    assert.equal(read.status, 'succeeded');
    assert.equal((read.output as any).title, 'Test Page');
    assert.ok((read.output as any).text.includes('Hello MARK'));
    assert.ok(!(read.output as any).text.includes('evil()'));
    assert.ok(!(read.output as any).text.includes('.x{}'));
    console.log('PASS (A): browser.read extracts text, strips scripts/styles');

    // B. Non-http schemes refused before any fetch/launch.
    const file = await kernel.execute(action('b-2', 'browser.read', { url: 'file:///etc/passwd' }), context());
    assert.equal(file.status, 'failed');
    assert.match(file.error ?? '', /only http\(s\)/);
    const js = await confirmedRun('b-3', 'browser.open', { url: 'javascript:alert(1)' });
    assert.equal(js.status, 'failed');
    assert.match(js.error ?? '', /only http\(s\)/);
    console.log('PASS (B): non-http schemes refused');

    // C. Binary content and HTTP errors fail honestly.
    const binary = await kernel.execute(action('b-4', 'browser.read', { url: `${base}/binary` }), context());
    assert.equal(binary.status, 'failed');
    assert.match(binary.error ?? '', /content type/);
    const missing = await kernel.execute(action('b-5', 'browser.read', { url: `${base}/nope` }), context());
    assert.equal(missing.status, 'failed');
    assert.match(missing.error ?? '', /404/);
    console.log('PASS (C): binary content and HTTP errors fail honestly');

    // D. browser.open gates behind confirmation (reversible risk) without launching.
    const open = await kernel.execute(action('b-6', 'browser.open', { url: `${base}/page` }), context());
    assert.equal(open.status, 'blocked');
    assert.ok(String((open.metadata as any)?.confirmationId ?? '').length > 0);
    console.log('PASS (D): browser.open requires confirmation before launching');
  } finally {
    server.close();
  }

  console.log('PASS: browser tool tests complete');
}

main().catch(error => {
  console.error('FAIL: browser tool test');
  console.error(error);
  process.exitCode = 1;
});
