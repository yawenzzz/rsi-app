import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    exclude: ['tests/**/*.e2e.ts'],
    pool: 'forks', maxWorkers: 4, testTimeout: 30000, hookTimeout: 30000,
    server: { deps: { inline: [/@deepseek-ai\/dsh-client-ui-primitives(?:\/|$)/] } },
  },
})
