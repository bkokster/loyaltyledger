import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';
import path from 'path';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    globals: true,
    reporters: ['default'],
    coverage: {
      enabled: false,
    },
  },
  resolve: {
    alias: {
      '@loyaltyledger/core': path.resolve(rootDir, 'packages/core/src/index.ts'),
    },
  },
});
