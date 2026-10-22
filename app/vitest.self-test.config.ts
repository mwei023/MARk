import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'src/agents/code-repair.self-test.test.ts',
      'src/core/mark-build-ship.self-test.test.ts',
    ],
    testTimeout: 60000,
  },
});
