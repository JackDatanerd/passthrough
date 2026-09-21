import { defineConfig } from 'vitest/config'

// One runner for both halves of the repo: the Worker (src/) and the pure logic
// modules of the SPA (frontend/src/lib). React components are covered by the
// frontend build in CI and by the shared-logic tests here; they need a DOM
// environment that this project doesn't install.
export default defineConfig({
  test: {
    environment: 'node',
    // tests/webhooks etc. seed Node's require.cache to stub CommonJS modules, and
    // frontend/tests/utils changes process.env.TZ — both need real child
    // processes rather than worker threads.
    pool: 'forks',
    include: ['tests/**/*.test.js', 'frontend/tests/**/*.test.js'],
    exclude: ['**/node_modules/**', 'frontend/dist/**', '.wrangler/**'],
    coverage: {
      // Needs `npm i -D @vitest/coverage-v8` (not added here so package-lock.json stays in sync).
      provider: 'v8',
      include: ['src/**/*.js', 'frontend/src/lib/**/*.js'],
      exclude: ['src/index.js'],
      reporter: ['text-summary', 'lcov'],
    },
  },
})
