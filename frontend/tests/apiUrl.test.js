import { describe, it, expect } from 'vitest'
import { resolveApiBase } from '../src/lib/apiUrl.js'

// Every Worker route is under /api. The docs used to say VITE_API_URL=https://api.passthrough.dev
// (no suffix), which sent every production request to a 404.
describe('resolveApiBase', () => {
  it('defaults to the dev proxy path', () => {
    for (const v of [undefined, null, '', '   ']) expect(resolveApiBase(v)).toBe('/api')
  })
  it('appends /api to a bare host', () => {
    expect(resolveApiBase('https://api.passthrough.dev')).toBe('https://api.passthrough.dev/api')
    expect(resolveApiBase('https://api.passthrough.dev/')).toBe('https://api.passthrough.dev/api')
  })
  it('does not double the suffix', () => {
    expect(resolveApiBase('https://api.passthrough.dev/api')).toBe('https://api.passthrough.dev/api')
    expect(resolveApiBase('https://api.passthrough.dev/api/')).toBe('https://api.passthrough.dev/api')
    expect(resolveApiBase('https://x.workers.dev/API')).toBe('https://x.workers.dev/API')
  })
  it('trims whitespace', () => {
    expect(resolveApiBase('  https://api.passthrough.dev  ')).toBe('https://api.passthrough.dev/api')
  })
})
