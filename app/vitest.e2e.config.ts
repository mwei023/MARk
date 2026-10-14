import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/api/proposal-approval.e2e.test.ts'],
    exclude: ['src/_archive/**', 'node_modules/**'],
    testTimeout: 30000,
  },
});
