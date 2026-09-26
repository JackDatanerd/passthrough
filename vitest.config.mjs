import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// One runner for the whole repo: the Worker (src/), the pure logic modules of
// the SPA (frontend/src/lib), and — since the Section 11/12 audit — the React
// component/hook layer (frontend/src/components, frontend/src/hooks) too.
//
// FEATURE GAP CLOSED: every one of those React files used to have zero
// automated coverage, and couldn't get any under the old setup — this file's
// own comment used to say so ("they need a DOM environment that this project
// doesn't install"), and frontend/tests/useReferralCapture.test.js says the
// same about its hook in so many words. The CI "frontend" job only ever ran
// `npm run build` (a compile check, not a behavior check), so every
// "BUG FIX (audit)" already embedded as a comment in Modal.jsx, Toast.jsx,
// FileUpload.jsx, useApi.js etc. was a manually-found, manually-fixed
// regression with nothing to catch it recurring.
//
// The `environment` stays 'node' by default on purpose: switching it
// globally to jsdom would run all ~60 existing Node-only tests (webhook
// require.cache stubbing, TZ manipulation, etc.) under a DOM they don't need
// and were never written against. Component/hook test files opt into jsdom
// individually with a `// @vitest-environment jsdom` comment at the top of
// the file instead — see frontend/tests/components/*.test.jsx — so this
// changes nothing for any test that doesn't ask for it.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    // tests/webhooks etc. seed Node's require.cache to stub CommonJS modules, and
    // frontend/tests/utils changes process.env.TZ — both need real child
    // processes rather than worker threads.
    pool: 'forks',
    include: ['tests/**/*.test.js', 'frontend/tests/**/*.test.{js,jsx}'],
    exclude: ['**/node_modules/**', 'frontend/dist/**', '.wrangler/**'],
    coverage: {
      // Needs `npm i -D @vitest/coverage-v8` (not added here so package-lock.json stays in sync).
      provider: 'v8',
      include: ['src/**/*.js', 'frontend/src/lib/**/*.js', 'frontend/src/components/**/*.jsx', 'frontend/src/hooks/**/*.js'],
      exclude: ['src/index.js'],
      reporter: ['text-summary', 'lcov'],
    },
  },
})
