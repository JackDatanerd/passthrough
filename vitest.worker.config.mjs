import { defineConfig } from 'vitest/config'

// Backend-only run: the Worker (src/) and its tests in tests/. Needs nothing but the root
// `npm ci`, so it is what CI's Worker job and `npm run predeploy` use. (`npm test` runs the
// whole repo including the React component tests, which also need frontend/'s own dependencies.)
export default defineConfig({
  test: {
    environment: 'node',
    // Twelve test files start an in-process Postgres (PGlite, WebAssembly). Cold, on a busy CI runner, that alone can pass vitest's
    // default 5 seconds, which made the Worker job fail at random on whichever of them ran slowest. A timeout only bounds a test that
    // is STUCK, so a generous one costs nothing when everything is healthy.
    testTimeout: 30000,
    hookTimeout: 120000,
    pool: 'forks',          // tests seed require.cache — real child processes, not threads
    include: ['tests/**/*.test.js'],
    exclude: ['**/node_modules/**', 'frontend/**', '.wrangler/**'],
  },
})
