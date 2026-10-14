import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.unit.test.ts'],
    exclude: ['src/_archive/**', 'node_modules/**'],
    testTimeout: 10000,
  },
});
