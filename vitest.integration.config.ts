import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/harness/**/*.e2e.ts'],
    pool: 'forks', maxWorkers: 2, testTimeout: 120000, hookTimeout: 30000,
  },
})
