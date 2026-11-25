import { defineConfig } from 'vitest/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@web-audio-tools/audio-core': resolve(here, '../../libs/audio-core/src/index.ts')
    }
  },
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 30000
  }
});