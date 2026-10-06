import { defineConfig } from 'vitest/config'

// Backend-only run: the Worker (src/) and its tests in tests/. Needs nothing but the root
// `npm ci`, so it is what CI's Worker job and `npm run predeploy` use. (`npm test` runs the
// whole repo including the React component tests, which also need frontend/'s own dependencies.)
export default defineConfig({
  test: {
    environment: 'node',
    pool: 'forks',          // tests seed require.cache — real child processes, not threads
    include: ['tests/**/*.test.js'],
    exclude: ['**/node_modules/**', 'frontend/**', '.wrangler/**'],
  },
})
