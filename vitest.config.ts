import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/services/kalshi/**/*.ts', 'src/services/dflow/**/*.ts', 'src/utils/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
    testTimeout: 30000, // 30s for integration tests
  },
});
