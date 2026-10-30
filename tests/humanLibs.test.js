import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const locks = require('../src/lib/humanLocks')
const { wordDiff, diffDocuments } = require('../src/lib/humanDiff')
const { newFigures, figuresIn } = require('../src/lib/humanFacts')
const totp = require('../src/lib/totp')
const pilot = require('../src/lib/humanPilot')

const RESUME = {
  name: 'Wanjiru Kamau', email: 'wanjiru.k@example.com', phone: '+254 712 345 678', location: 'Nairobi, Kenya',
  linkedin: 'linkedin.com/in/wanjirukamau', portfolio: 'https://wanjiru.dev',
  summary: 'Wanjiru is a product manager. Reach her at wanjiru.k@example.com.',
  experience: [{ company: 'Acme Ltd', title: 'Product Manager', dates: '2019 - 2023', location: 'Nairobi',
    bullets: ['Grew active users 40% across 3 markets.', 'Call +1 (415) 555-0132 for references or see https://acme.example.com/team.'] }],
  education: [{ institution: 'University of Nairobi', degree: 'BSc Economics', dates: '2013 - 2017', details: 'First class honours' }],
  skills: ['SQL', 'Node.js', 'Roadmapping'], projects: [{ name: 'Tracker', description: 'Built a tracker.', link: 'https://github.com/wk/tracker' }],
  references: [{ name: 'Jane Roe', phone: '+1 555 000 1111' }]
}

describe('humanLocks', () => {
  it('lifts every contact value, project link, reference and in-text contact; the masked body holds no real contact detail', () => {
    const { body, locked } = locks.lockDocument(RESUME)
    const json = JSON.stringify(body)
    for (const secret of ['wanjiru.k@example.com', '+254 712 345 678', 'linkedin.com/in/wanjirukamau', 'wanjiru.dev', 'github.com/wk/tracker', '555-0132', 'acme.example.com', 'Jane Roe', 'Wanjiru', 'Kamau']) expect(json, secret).not.toContain(secret)
    expect(body.name).toBe('[[lock:name]]')
    expect(body.projects[0].link).toBe('[[lock:projects.0.link]]')
    expect(body.experience[0].company).toBe('Acme Ltd')           // visible, read-only
    expect(Object.keys(locked).length).toBeGreaterThan(9)
  })
  it('round-trips EXACTLY: restore(lock(x)) equals x, nothing missing', () => {
    const { body, locked } = locks.lockDocument(RESUME)
    const { data, missing } = locks.restoreDocument(body, locked)
    expect(missing).toEqual([])
    expect(data).toEqual(RESUME)
  })
  it('does not mistake a date range, a salary figure or a skill name for a phone number or address', () => {
    const { body, locked } = locks.lockDocument({ name: 'Al Bo', experience: [{ company: 'X', bullets: ['Managed $1,200,000 budget 2019 - 2023', 'Built with Node.js and Next.js'] }], skills: ['Vue.js'] })
    expect(body.experience[0].bullets).toEqual(['Managed $1,200,000 budget 2019 - 2023', 'Built with Node.js and Next.js'])
    expect(body.skills).toEqual(['Vue.js']); expect(Object.keys(locked)).toEqual(['lock:name'])
  })
  const base = () => locks.lockDocument(RESUME).body
  const edit = fn => { const n = JSON.parse(JSON.stringify(base())); fn(n); return locks.validateEdit(base(), n) }
  it('accepts a rewrite of editable text, including adding and removing bullets', () => {
    expect(edit(n => { n.summary = 'Product manager who grows products.'; n.experience[0].bullets.push('Led a team.'); n.skills = ['SQL'] }).ok).toBe(true)
  })
  it.each([
    ['a locked contact field', n => { n.email = 'x@y.com' }, 'LOCKED_FIELD_CHANGED'],
    ['a removed locked field', n => { delete n.phone }, 'LOCKED_FIELD_REMOVED'],
    ['a read-only anchor (employer)', n => { n.experience[0].company = 'Globex' }, 'READ_ONLY_CHANGED'],
    ['a read-only anchor (dates)', n => { n.education[0].dates = '2010 - 2014' }, 'READ_ONLY_CHANGED'],
    ['a dropped job', n => { n.experience = [] }, 'ENTRY_COUNT_CHANGED'],
    ['a typed email', n => { n.summary = 'write to me@mine.com' }, 'CONTACT_IN_TEXT'],
    ['a typed phone number', n => { n.summary = 'call 0712 345 678' }, 'CONTACT_IN_TEXT'],
    ['a typed web address', n => { n.skills.push('see mysite.com') }, 'CONTACT_IN_TEXT'],
    ['an invented marker', n => { n.summary = '[[c:99]]' }, 'UNKNOWN_MARKER'],
    ['a duplicated marker', n => { n.summary += ' [[lock:name]]' }, 'MARKER_DUPLICATED'],
    ['a new section', n => { n.hobbies = ['golf'] }, 'SECTION_NOT_ALLOWED'],
    ['a non-text value', n => { n.skills = [5] }, 'NOT_TEXT'],
  ])('refuses %s', (_l, fn, code) => { const r = edit(fn); expect(r.ok).toBe(false); expect(r.errors.map(e => e.code)).toContain(code) })
  it('refuses to restore when a marker the document needs has gone, and reports it', () => {
    const { body, locked } = locks.lockDocument(RESUME); delete body.name
    expect(locks.restoreDocument(body, locked).missing).toContain('lock:name')
  })
})

describe('humanDiff', () => {
  it('word diff marks inserted and deleted words and keeps equal text', () => {
    expect(wordDiff('Led a team of five', 'Led a team of seven engineers')).toEqual([{ t: 'eq', text: 'Led a team of ' }, { t: 'del', text: 'five' }, { t: 'ins', text: 'seven engineers' }])
  })
  it('path diff reports added, removed and changed leaves only', () => {
    const d = diffDocuments({ summary: 'a b', skills: ['x'] }, { summary: 'a c', skills: ['x', 'y'] })
    expect(d.map(c => [c.path, c.kind])).toEqual([['summary', 'changed'], ['skills.1', 'added']])
  })
})

describe('humanFacts', () => {
  it('reads figures with their symbols (a lone digit counts too) and ignores markers', () => {
    expect([...figuresIn('Grew 40% to $1,200,000 in 2023 across 3 markets; [[c:12]] 2 teams')].sort()).toEqual(['1200000', '2023', '2', '3', '40%'].sort())
  })
  it('flags a figure that is in none of the sources, accepts ones from source, brief or answers', () => {
    const final = { summary: 'Grew users 55% and cut cost 40%.' }
    expect(newFigures(final, [{ b: 'Grew active users 40%' }])).toEqual(['55%'])
    expect(newFigures(final, [{ b: 'Grew active users 40%' }], ['It was 55 %'])).toEqual([])
  })
})

describe('totp (RFC 6238 vectors, SHA-1, 8 digits)', () => {
  const secret = totp.base32Encode(new TextEncoder().encode('12345678901234567890'))
  it.each([[59, '94287082'], [1111111109, '07081804'], [1234567890, '89005924'], [2000000000, '69279037']])('t=%i -> %s', async (t, code) => {
    expect(await totp.hotp(secret, Math.floor(t / 30), 8)).toBe(code)
  })
  it('verifies within one step, refuses a replay of the same step and a wrong code', async () => {
    const now = 1_700_000_000_000, step = totp.stepOf(now), code = await totp.hotp(secret, step)
    expect(await totp.verifyTotp(secret, code, { nowMs: now })).toBe(step)
    expect(await totp.verifyTotp(secret, code, { nowMs: now, lastStep: step })).toBeNull()
    expect(await totp.verifyTotp(secret, await totp.hotp(secret, step - 1), { nowMs: now })).toBe(step - 1)
    expect(await totp.verifyTotp(secret, await totp.hotp(secret, step - 3), { nowMs: now })).toBeNull()
    expect(await totp.verifyTotp(secret, '000000', { nowMs: now })).toBeNull()
    expect(await totp.verifyTotp(secret, 'abcdef', { nowMs: now })).toBeNull()
  })
})

describe('humanPilot', () => {
  const S = { prices: { polish: 5900, seven_day: 8900, forty_eight_hour: 11900, twenty_four_hour: 14900, cover_letter: 2900 }, pay: { polish: 2500, seven_day: 5000, forty_eight_hour: 7000, twenty_four_hour: 9000, cover_letter: 1800 },
    tiers_enabled: { polish: false, seven_day: true, forty_eight_hour: true, twenty_four_hour: true }, turnaround_hours: { seven_day: 168, forty_eight_hour: 48, twenty_four_hour: 24 }, internal_buffer_hours: { forty_eight_hour: 4 },
    pilot_cap_orders: 15, accept_auto_hours: 72, revision_window_days: 7, earnings_hold_days: 3 }
  it('the flag is on only for exactly "true"; the allow-list is empty-means-nobody', () => {
    for (const v of [undefined, '', 'TRUE', '1', 'yes', 'true ']) expect(pilot.humanEnabled({ EXPERTS_ENABLED: v }), String(v)).toBe(v === 'true ')
    expect(pilot.userAllowed({}, { email: 'a@b.c' })).toBe(false)
    expect(pilot.userAllowed({ EXPERTS_ALLOWED_EMAILS: 'a@b.c, d@e.f' }, { email: 'D@E.F' })).toBe(true)
    expect(pilot.userAllowed({ EXPERTS_ALLOWED_EMAILS: 'a@b.c' }, { email: 'x@y.z' })).toBe(false)
    expect(pilot.userAllowed({ EXPERTS_ALLOWED_EMAILS: '*' }, { email: 'x@y.z' })).toBe(true)
  })
  it('quotes from the settings, adds the cover letter to price and pay, and refuses a disabled or unknown tier', () => {
    expect(pilot.quote(S, 'forty_eight_hour', true)).toMatchObject({ ok: true, priceCents: 14800, expertPayCents: 8800, tierPriceCents: 11900, coverPriceCents: 2900, kind: 'human_forty_eight_hour' })
    expect(pilot.quote(S, 'polish', false)).toEqual({ ok: false, code: 'TIER_UNAVAILABLE' })
    expect(pilot.quote(S, 'gold', false)).toEqual({ ok: false, code: 'BAD_TIER' })
  })
  it('deadlines come from turnaround and buffer; polish has none; settings with a missing figure are invalid', () => {
    const d = pilot.deadlines(S, 'forty_eight_hour', '2026-11-01T00:00:00Z')
    expect(d).toEqual({ promised: '2026-11-03T00:00:00.000Z', internal: '2026-11-02T20:00:00.000Z' })
    expect(pilot.deadlines(S, 'polish', '2026-11-01T00:00:00Z')).toEqual({ promised: null, internal: null })
    expect(pilot.validSettings(S)).toBe(true); expect(pilot.validSettings({ ...S, prices: { ...S.prices, seven_day: undefined } })).toBe(false)
  })
  it('job numbers are HJ- plus six unambiguous characters', () => { for (let i = 0; i < 50; i++) expect(pilot.newJobNumber()).toMatch(/^HJ-[2-9A-HJKMNP-TV-Z]{6}$/) })
})

describe('humanLocks: one map for several documents of a job', () => {
  it('source, AI draft and cover letter share one locked map; ids never collide and restore round-trips each', () => {
    const shared = { locked: {}, n: 0 }
    const a = locks.lockDocument(RESUME, shared)
    const draft = { ...RESUME, summary: 'Wanjiru Kamau drives growth. wanjiru.k@example.com', email: 'other@example.com' }
    const b = locks.lockDocument(draft, shared)
    const letter = locks.lockText('Dear team, I am Wanjiru. Call +254 712 345 678.', shared, RESUME.name)
    expect(b.body.email).toBe('[[lock:email]]')
    expect(shared.locked['lock:email']).toBe('wanjiru.k@example.com')           // the source's value wins
    const all = JSON.stringify([a.body, b.body, letter])
    for (const secret of ['wanjiru.k@example.com', '254 712', 'Wanjiru', 'Kamau', 'other@example.com']) expect(all, secret).not.toContain(secret)
    expect(locks.restoreDocument(a.body, shared.locked).data).toEqual(RESUME)
    expect(locks.restoreDocument({ summary: letter }, shared.locked).data.summary).toBe('Dear team, I am Wanjiru. Call +254 712 345 678.')
    const ids = Object.keys(shared.locked).filter(k => k.startsWith('c:')); expect(new Set(ids).size).toBe(ids.length)
  })
})
