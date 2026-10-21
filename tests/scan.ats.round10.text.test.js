// Scan/ATS round 10 — text cut in the middle of an emoji must never reach Postgres or the model.
import { describe, it, expect } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { safeSlice, stripLoneSurrogates } from '../src/lib/safeText.js'
import { fitJobDescription } from '../src/services/ats.service.js'
import uploadResume from '../src/middleware/upload.js'
import { parseClientResumeData } from '../src/lib/resumeData.js'

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const MAC = '\uD83D\uDE00'   // 😀

describe('safeText', () => {
  it('safeSlice never leaves half an emoji, at any cut point', () => {
    const s = `ab${MAC}cd${MAC}${MAC}ef`
    for (let n = 0; n <= s.length + 2; n++) expect(LONE.test(safeSlice(s, n)), `n=${n}`).toBe(false)
    expect(safeSlice(s, 3)).toBe('ab')           // the cut would have split the first emoji: it is dropped whole
    expect(safeSlice(s, 4)).toBe(`ab${MAC}`)     // a cut right after a whole emoji keeps it
  })
  it('safeSlice is a plain slice for ordinary text and tolerates null', () => {
    expect(safeSlice('hello world', 5)).toBe('hello'); expect(safeSlice(null, 5)).toBe(''); expect(safeSlice('hi', 50)).toBe('hi')
  })
  it('stripLoneSurrogates removes stray halves and keeps whole emoji', () => {
    expect(stripLoneSurrogates(`a\uD83D b ${MAC} c\uDE00`)).toBe(`a b ${MAC} c`)
    expect(stripLoneSurrogates(42)).toBe(42)
  })
})

describe('fitJobDescription: the cut can no longer split an emoji', () => {
  it('whatever the cap, the result is well-formed', () => {
    const jd = `Senior Engineer\n${'We build things 🚀 with care. '.repeat(40)}`
    for (let max = 200; max < 260; max++) expect(LONE.test(fitJobDescription(jd, max)), `max=${max}`).toBe(false)
  })
})

describe('the original failure, on a real Postgres', () => {
  it('a text cut inside an emoji was refused by the insert; the safe cut is accepted', async () => {
    const db = new PGlite()
    await db.exec('create table t (body text)')
    const text = 'a'.repeat(9) + MAC + 'b'
    const insert = body => db.query(`insert into t select body from json_populate_record(null::t, $1::json)`, [JSON.stringify({ body })])
    await expect(insert(text.slice(0, 10))).rejects.toThrow(/invalid input syntax for type json/)
    await expect(insert(safeSlice(text, 10))).resolves.toBeDefined()
  })
})

describe('the upload middleware cleans text fields at the door', () => {
  async function run(fields) {
    const fd = new FormData()
    for (const [k, v] of Object.entries(fields)) fd.append(k, v)
    const res = new Response(fd)   // serialises with a boundary
    const ct = res.headers.get('content-type')
    const request = new Request('http://x/scan', { method: 'POST', body: res.body, headers: { 'content-type': ct }, duplex: 'half' })
    const store = {}
    const ctx = { req: { header: n => (n === 'content-type' ? ct : undefined), raw: request }, json: (b, s) => ({ b, s }), set: (k, v) => { store[k] = v }, get: k => store[k] }
    await uploadResume(ctx, async () => 'next')
    return store.formFields
  }
  // (A lone surrogate cannot arrive in multipart: UTF-8 has no encoding for one, so the browser sends U+FFFD. Only the CUT
  //  can create one here; the JSON bodies are covered below.)
  it('a field longer than its cap is cut without splitting an emoji', async () => {
    const f = await run({ contactName: 'a'.repeat(99) + MAC + 'zzz' })   // cap 100: the cut lands inside the emoji
    expect(LONE.test(f.contactName)).toBe(false); expect(f.contactName).toBe('a'.repeat(99))
  })
})

describe('structured resume data from the client', () => {
  it('a lone surrogate in a value or a key is removed (jsonb refuses it)', () => {
    const r = parseClientResumeData({ name: 'Jane\uD83D', summary: 'Engineer', experience: [{ company: 'Acme', title: 'Dev', dates: '2020', bullets: ['Built things\uDE00 for teams'] }], skills: [], education: [], certifications: [], projects: [] })
    expect(r.ok).toBe(true)
    expect(JSON.stringify(r.data)).not.toMatch(/\\ud8|\\ude/i)
    expect(r.data.name).toBe('Jane')
  })
})

// Scan/ATS round 16: the zone-by-zone fit sliced each zone by raw index and only the END of the joined result was
// protected, so a cut inside a MIDDLE zone (the company-intro cap, or a zone that ranks above a later one in the page)
// left half an emoji in the stored posting - and the insert then fails on Postgres.
describe('fitJobDescription: a cut inside a middle zone cannot leave half an emoji', () => {
  it('whatever the cap, a multi-zone posting is well-formed', () => {
    const jd = n => `Senior Engineer\nAbout us\n${'We are a mission-driven team 🚀 shipping daily. '.repeat(n)}\nWhat you will do\n${'Build services 🐍 and APIs. '.repeat(n)}\nRequirements\n${'5+ years of Python 🐍 and SQL. '.repeat(n)}\nBenefits\n${'Great perks 🎉 and snacks. '.repeat(n)}\nEqual opportunity employer\n${'We celebrate diversity 🌍 always. '.repeat(n)}`
    for (const n of [20, 60, 120]) for (let max = 300; max < 2500; max++)
      expect(LONE.test(fitJobDescription(jd(n), max)), `n=${n} max=${max}`).toBe(false)
  })
})
