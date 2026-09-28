// Shared setup for every test file (registered via `setupFiles` in
// vitest.config.mjs).
//
// BUG FIX (Section 12 audit): two things every jsdom component test in this
// repo silently depends on were never actually wired up:
//
//  1. @testing-library/jest-dom is a devDependency and ~40 assertions use its
//     matchers (toBeInTheDocument, toBeDisabled, toHaveAttribute, ...), but
//     nothing anywhere registered them with vitest's expect — no setup file,
//     no `import '@testing-library/jest-dom/vitest'`. An unregistered matcher
//     isn't a soft failure, it's a TypeError the first time it's called.
//
//  2. @testing-library/react only auto-registers its afterEach(cleanup) when
//     `afterEach` is a GLOBAL, and vitest's `globals` is off by default (and
//     off here). Without cleanup, every render() in a file stays mounted for
//     the rest of that file, so a later getByRole('button', { name: 'Save' })
//     finds the earlier test's button too and throws "multiple elements".
//
// Both registrations are idempotent — a test file that already imports
// jest-dom or calls cleanup itself is unaffected. The DOM half is skipped for
// the Node-environment tests (Worker code, require.cache stubbing, TZ
// manipulation) so this changes nothing for them.
import { afterEach, expect } from 'vitest'
import * as matchers from '@testing-library/jest-dom/matchers'

expect.extend(matchers)

if (typeof document !== 'undefined') {
  const { cleanup } = await import('@testing-library/react')
  afterEach(() => cleanup())
}
