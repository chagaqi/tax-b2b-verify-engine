import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.{ts,tsx}'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 60_000,
    pool: 'forks',
    reporters: ['default'],
  },
  esbuild: { jsx: 'automatic' },
});
