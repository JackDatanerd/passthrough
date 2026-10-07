import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { filled, manualHasContent } from '../src/lib/resumeForm'

// Found during the Auth round 3 audit: ScanForm.jsx called `filled(...)` for a signed-out visitor's
// manual entry, but the helper was private to resumeForm.js — a ReferenceError the moment such a
// visitor pressed submit, and a lint failure that also blocks `npm run predeploy`.
describe('resumeForm.filled', () => {
  it('is exported and means "a non-blank string"', () => {
    expect(filled('Ada')).toBeTruthy()
    expect(filled('   ')).toBeFalsy()
    expect(filled(undefined)).toBeFalsy()
    expect(filled(12)).toBeFalsy()
  })
  it('ScanForm imports it rather than calling an undefined global', () => {
    const src = readFileSync(new URL('../src/components/scan/ScanForm.jsx', import.meta.url), 'utf8')
    expect(src).toMatch(/import \{[^}]*\bfilled\b[^}]*\} from '..\/..\/lib\/resumeForm'/)
  })
  it('manualHasContent still works', () => {
    expect(manualHasContent({ summary: 'x' })).toBe(true)
    expect(manualHasContent({})).toBe(false)
  })
})
