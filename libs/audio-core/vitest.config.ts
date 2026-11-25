import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    // These integration tests encode real audio through lamejs; give them
    // headroom when CI runs builds/lint/tests in parallel.
    testTimeout: 30000,
    hookTimeout: 30000
  }
});