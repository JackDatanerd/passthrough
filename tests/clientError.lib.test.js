import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { normalizePath, redactText, sanitizeReport, fingerprintInput, formatAlert, LIMITS } = require('../src/lib/clientError')

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSIsInNpZCI6InMxIn0.abcDEF123_-xyz'

describe('normalizePath — a page address with nothing that identifies a person or a document', () => {
  it('drops the query string and hash', () => {
    expect(normalizePath('/reset-password?token=abc123&x=1#frag')).toBe('/reset-password')
  })
  it('flattens ids, verification codes and opaque segments', () => {
    expect(normalizePath('/scan/11111111-1111-4111-8111-111111111111')).toBe('/scan/:id')
    expect(normalizePath('/v/K7M2QX9P4A')).toBe('/v/:code')
    expect(normalizePath('/employer/confirm/aaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe('/employer/confirm/:token')
  })
  it('keeps ordinary routes and tolerates junk', () => {
    expect(normalizePath('/dashboard/settings')).toBe('/dashboard/settings')
    expect(normalizePath('')).toBe('/')
    expect(normalizePath(undefined)).toBe('/')
    expect(normalizePath('no-leading-slash')).toBe('/no-leading-slash')
  })
  it('clips an absurd path', () => {
    expect(normalizePath('/' + 'a/'.repeat(500)).length).toBeLessThanOrEqual(LIMITS.path + 10)
  })
})

describe('redactText — credentials and addresses never reach an alert', () => {
  it('removes a session token, a bearer header, an email and an id', () => {
    const out = redactText(`failed for jane.doe@example.com with ${JWT} and Bearer abcdef1234567890 on 11111111-1111-4111-8111-111111111111`)
    expect(out).not.toMatch(/jane|eyJ|abcdef1234567890|1111-1111/)
    expect(out).toContain('[email]'); expect(out).toContain('[jwt]'); expect(out).toContain('[id]')
  })
  it('removes secret query parameters and any query string left on an address', () => {
    const out = redactText('GET https://app.example.com/reset-password?token=SECRETVALUE&next=/x failed at https://x.dev/a?b=c#d')
    expect(out).not.toMatch(/SECRETVALUE|b=c|next=/)
    expect(out).toContain('https://x.dev/a')
  })
  it('removes a long opaque run', () => {
    expect(redactText(`key ${'A1b2'.repeat(15)} end`)).toContain('[token]')
  })
  it('leaves an ordinary error message alone', () => {
    expect(redactText("Cannot read properties of undefined (reading 'map')")).toBe("Cannot read properties of undefined (reading 'map')")
  })
  it('is safe on non-strings', () => { expect(redactText(undefined)).toBe(''); expect(redactText(42)).toBe('') })
})

describe('sanitizeReport', () => {
  it('needs an object with a message', () => {
    expect(sanitizeReport(null)).toBeNull()
    expect(sanitizeReport([])).toBeNull()
    expect(sanitizeReport({ message: '   ' })).toBeNull()
    expect(sanitizeReport({ stack: 'x' })).toBeNull()
  })
  it('clips every field and scrubs the text ones', () => {
    const r = sanitizeReport({ kind: 'render', message: 'word '.repeat(1000), stack: `at ${JWT} ` + 'frame '.repeat(2000), componentStack: 'comp '.repeat(2000), path: '/scan/11111111-1111-4111-8111-111111111111?token=abc', build: 'assets/index-AbC123.js' })
    expect(r.message.length).toBe(LIMITS.message)
    expect(r.stack.length).toBeLessThanOrEqual(LIMITS.stack)
    expect(r.stack).not.toContain('eyJ')
    expect(r.componentStack.length).toBeLessThanOrEqual(LIMITS.componentStack)
    expect(r.path).toBe('/scan/:id')
    expect(r.build).toBe('assets/index-AbC123.js')
  })
  it('turns an unknown kind into "error" and refuses a build id that is not a file name', () => {
    const r = sanitizeReport({ kind: 'drop table', message: 'x', build: '<script>alert(1)</script>' })
    expect(r.kind).toBe('error')
    expect(r.build).toBe('')
  })
})

describe('fingerprint + alert text', () => {
  it('is the same for the same error and flattens numbers, so a changing line number or count is one error', () => {
    const a = fingerprintInput({ kind: 'render', path: '/scan/:id', message: 'Item 12 of 40 missing' })
    const b = fingerprintInput({ kind: 'render', path: '/scan/:id', message: 'Item 3 of 9 missing' })
    expect(a).toBe(b)
    expect(a).not.toBe(fingerprintInput({ kind: 'render', path: '/pricing', message: 'Item 3 of 9 missing' }))
  })
  it('says the text is unverified and includes what the owner needs', () => {
    const t = formatAlert({ kind: 'chunk', path: '/pricing', build: 'assets/index-x.js', message: 'boom', stack: 'at f', componentStack: '' })
    expect(t).toMatch(/unverified/i)
    expect(t).toContain('kind:  chunk'); expect(t).toContain('page:  /pricing'); expect(t).toContain('build: assets/index-x.js'); expect(t).toContain('boom')
  })
})
