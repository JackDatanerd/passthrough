import { describe, it, expect } from 'vitest'
import { stripNul } from '../src/middleware/bodyLimit.js'
import { stripNul as stripNulResume } from '../src/lib/resumeData.js'
import fs from 'node:fs'

describe('cross-cutting infra round 12', () => {
  it('bodyLimit.stripNul never turns a NUL-split "__proto__" key into the body prototype', () => {
    const body = JSON.parse('{"__pro\\u0000to__":{"role":"ADMIN"},"email":"a@b.c"}')
    const out = stripNul(body)
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(out.role).toBeUndefined()
    expect(Object.keys(out).sort()).toEqual(['__proto__', 'email'])
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true)
  })
  it('bodyLimit.stripNul still cleans keys and values', () => {
    expect(stripNul({ a: 'x\u0000y', 'k\u0000': ['\u0000z', 1, null] })).toEqual({ a: 'xy', k: ['z', 1, null] })
  })
  it('resumeData.stripNul keeps a client "__proto__" key as plain data', () => {
    const out = stripNulResume(JSON.parse('{"__proto__":{"summary":"x"},"name":"n"}'))
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(out.summary).toBeUndefined()
    expect(out.name).toBe('n')
  })
  it('DEPLOYMENT.md: balanced code fences, no stale currency or schema-bump instructions', () => {
    const md = fs.readFileSync(new URL('../DEPLOYMENT.md', import.meta.url), 'utf8')
    expect((md.match(/^```/gm) || []).length % 2).toBe(0)
    expect(md).not.toMatch(/There is no conversion:\*\* the price constants/)
    expect(md).not.toMatch(/bump\s+#?\s*EXPECTED_SCHEMA_VERSION to 82/)
    expect(md).toMatch(/PRICES_BY_CURRENCY/)
  })
})
