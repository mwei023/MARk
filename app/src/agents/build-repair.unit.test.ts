import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repairMissingUnusedImport } from './build-repair.js';

describe('build repair', () => {
  it('removes an unused missing local import only when the build passes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mark-build-repair-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      private: true,
      scripts: { build: 'node -e "const fs=require(\\\"fs\\\"); if (fs.readFileSync(\\\"src/App.jsx\\\",\\\"utf8\\\").includes(\\\"MissingSection\\\")) process.exit(1)"' },
    }));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/App.jsx'), "import MissingSection from './components/sections/MissingSection'\nexport default function App() {}\n");

    const result = await repairMissingUnusedImport(root, 'Could not resolve "./components/sections/MissingSection" from "src/App.jsx"');

    expect(result.fixed).toBe(true);
    expect(readFileSync(join(root, 'src/App.jsx'), 'utf8')).not.toContain('MissingSection');
  });
});
