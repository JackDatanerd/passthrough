import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const locks = require('../src/lib/humanLocks')
const { wordDiff, diffDocuments } = require('../src/lib/humanDiff')
const { newFigures, newFiguresDetailed, figuresIn } = require('../src/lib/humanFacts')
const pilot = require('../src/lib/humanPilot')
const view = require('../src/lib/expertView')

// Experts audit A5 (locking, masking, diff, fact check, files), round 1. One test per confirmed defect.

describe('A5 masking: names', () => {
  it('lifts an accented or non-Latin name (the ASCII-only word boundary used to miss it)', () => {
    expect(locks.lockDocument({ name: 'José Álvarez', summary: 'José is a baker. Álvarez leads.' }).body.summary).not.toMatch(/José|Álvarez/)
    expect(locks.lockDocument({ name: 'Анна Иванова', summary: 'Анна работает. Иванова лидер' }).body.summary).not.toMatch(/Анна|Иванова/)
  })
  it('does not lift an ordinary lower-case word because the client\'s surname or first name is that word', () => {
    expect(locks.lockDocument({ name: 'John Baker', summary: 'Experienced baker. Baker led.' }).body.summary).toBe('Experienced baker. [[c:1]] led.')
    expect(locks.lockDocument({ name: 'Will Smith', summary: 'I will lead and will deliver.' }).body.summary).toBe('I will lead and will deliver.')
  })
  it('lifts the whole name in either order, and a name written in capitals', () => {
    expect(locks.lockDocument({ name: 'Jane Doe', summary: 'Doe, Jane and JANE and jane doe' }).body.summary).not.toMatch(/doe|jane/i)
  })
})

describe('A5 masking: what else is a contact detail', () => {
  const lift = s => locks.lockDocument({ name: 'Jane Doe', summary: s }).body.summary
  it.each(['site janedoe.io', 'janedoe.xyz', 'jane.tech', 'jane.co.ke', 'call 555-1234', 'tel: 0712 345 678', '12 Kenyatta Avenue', 'P.O. Box 12345', 'twitter: @janedoe', 'jane dot doe at gmail dot com', 'jane(at)gmail(dot)com'])('lifts %s', s => {
    expect(lift(s)).toMatch(/\[\[c:\d+\]\]/)
  })
  it('the client\'s own contact values are scrubbed wherever they appear in free text (an address in an uploaded CV, say)', () => {
    const shared = { locked: {}, n: 0 }
    locks.lockDocument({ name: 'Jane Doe', email: 'jane@x.com', phone: '+254 712 345 678', location: 'Nairobi, Kenya', linkedin: 'https://linkedin.com/in/jane', summary: 'x' }, shared)
    const out = locks.lockText('Jane Doe\nNairobi,  Kenya\n0712-345-678 | linkedin.com/in/jane\nI have led work in Kenya.', shared, '')
    expect(out).not.toMatch(/Nairobi|712|linkedin|Jane/)
    expect(out).toContain('led work in Kenya')                         // a country word on its own is not the client's address
  })
  it('does not call a list of years, a spaced number or a technology name a phone number or address', () => {
    for (const s of ['Certified 2019 2020 2021', 'Handled 1 234 567 890 records', 'Built the ASP.NET portal with Socket.io', 'Joined 2021-2022-2023']) expect(locks.hasContact(s), s).toBe(false)
  })
})

describe('A5 masking: linear time', () => {
  it.each([['12-'.repeat(20000) + 'z'], ['a.'.repeat(30000)], ['a'.repeat(60000) + '.com'], ['a-'.repeat(30000) + '.com'], ['1 '.repeat(30000) + 'x']])('a crafted 60,000-character text is scanned in well under a second', s => {
    const t = Date.now(); locks.contactSpans(s); expect(Date.now() - t).toBeLessThan(750)
  })
})

describe('A5 locks: the document the expert works from decides the contact values', () => {
  const source = { name: 'Jane Doe', email: 'jane.typo@gmail.com', phone: '0700 000 000', linkedin: 'linkedin.com/in/jane', projects: [{ name: 'A', link: 'https://a.example.com' }, { name: 'B', link: 'https://b.example.com' }], summary: 's', experience: [] }
  const draft = { name: 'Jane Doe', email: 'jane@gmail.com', phone: '0711 111 111', projects: [{ name: 'B', link: 'https://b.example.com' }], summary: 's2', experience: [] }
  const lockBoth = () => { const shared = { locked: {}, n: 0 }; locks.lockDocument(source, shared); const dr = locks.lockDocument(draft, shared, { override: true }); return { shared, dr } }
  it('restores the customer\'s edited email, phone and the right project link (not the original\'s)', () => {
    const { shared, dr } = lockBoth()
    const r = locks.restoreDocument(dr.body, shared.locked)
    expect(r.data.email).toBe('jane@gmail.com'); expect(r.data.phone).toBe('0711 111 111'); expect(r.data.projects[0].link).toBe('https://b.example.com')
  })
  it('a field the draft never had is not "missing" when the starting document did not carry its marker (delivery used to be blocked for good)', () => {
    const { shared, dr } = lockBoth()
    expect(locks.restoreDocument(dr.body, shared.locked).missing.length).toBeGreaterThan(0)                 // the old rule
    const required = Object.keys(locks.markerCounts(dr.body)).filter(k => k.startsWith('lock:'))
    expect(locks.restoreDocument(dr.body, shared.locked, { required }).missing).toEqual([])
    const gone = JSON.parse(JSON.stringify(dr.body)); delete gone.email
    expect(locks.restoreDocument(gone, shared.locked, { required }).missing).toEqual(['lock:email'])         // a marker the starting document had is still required
  })
})

describe('A5 validateEdit', () => {
  const base = locks.lockDocument({ name: 'Jane Doe', summary: 'x', experience: [], skills: [] }).body
  const ok = { name: '[[lock:name]]', summary: 'x', experience: [], skills: [] }
  it('refuses a "__proto__" key and the built-in names as a way round the section check', () => {
    expect(locks.validateEdit(base, JSON.parse('{"name":"[[lock:name]]","summary":"x","experience":[],"skills":[],"__proto__":"call jane@evil.com"}')).errors.map(e => e.code)).toContain('RESERVED_KEY')
    expect(locks.validateEdit(base, JSON.parse('{"name":"[[lock:name]]","summary":"x","experience":[],"skills":[],"constructor":{"a":"b"},"toString":"z"}')).errors.map(e => e.code)).toContain('SECTION_NOT_ALLOWED')
  })
  it('refuses absurd nesting with a clear code rather than crashing', () => {
    let deep = 'x'; for (let i = 0; i < 40; i++) deep = [deep]
    expect(locks.validateEdit(base, { ...ok, skills: deep }).errors.map(e => e.code)).toContain('TOO_DEEP')
  })
  it('only judges text the expert changed: a line already in the baseline never blocks a save', () => {
    const b = { ...base, skills: ['see portfolio.xyz'] }
    expect(locks.validateEdit(b, { ...b }).ok).toBe(true)
    expect(locks.validateEdit(b, { ...b, skills: ['see portfolio.xyz', 'and mysite.io'] }).errors.map(e => e.code)).toContain('CONTACT_IN_TEXT')
  })
  it('a number the baseline already holds does not make every save fail NOT_TEXT, but a new one does', () => {
    const b = { ...ok, extra: { years: 5 } }
    expect(locks.validateEdit({ ...base, extra: { years: 5 } }, b).ok).toBe(true)
    const b2 = { ...base, summary: 'x' }; b2.skills = [5]
    expect(locks.validateEdit(base, b2).errors.map(e => e.code)).toContain('NOT_TEXT')
  })
})

describe('A5 the fact check', () => {
  it('reads values, not spellings: $1.2 million = $1.2M, 30 percent = 30%, $50,000 = 50k', () => {
    expect(newFigures({ s: 'Saved $1.2 million; cut churn 30 percent; managed 50k' }, [{ s: 'Saved $1.2M, churn down 30%, a $50,000 budget' }])).toEqual([])
  })
  it('flags an invented lone digit, a spelled-out quantity and a multiplier', () => {
    expect(newFigures({ s: 'Led a team of 8 and grew it to nine; tripled revenue and cut costs in half' }, [{ s: 'Led a team' }])).toEqual(expect.arrayContaining(['8', 'nine', 'tripled', 'in half']))
  })
  it('accepts a spelled-out quantity the client wrote as a digit', () => {
    expect(newFigures({ s: 'Led five engineers' }, [{ s: 'Led 5 engineers' }])).toEqual([])
  })
  it('keeps "10+" a different claim from "10"', () => { expect(newFigures({ s: '10+ years' }, [{ s: '10 years' }])).toEqual(['10+']) })
  it('a figure only the AI draft or the job posting carries is flagged and says where it came from; client sources clear it', () => {
    const d = newFiguresDetailed({ s: 'Grew sales 70%, 10+ years, 12 reports' }, [{ s: 'Grew sales' }], [], { ai_draft: [{ s: 'Grew sales 70%' }], job_posting: ['10+ years required'] })
    expect(d.map(f => [f.text, f.origin])).toEqual(expect.arrayContaining([['70%', 'ai_draft'], ['10+', 'job_posting'], ['12', 'nowhere']]))
    expect(newFigures({ s: 'Grew sales 70%' }, [{ s: 'sales grew 70%' }])).toEqual([])
  })
  it('ignores markers', () => { expect([...figuresIn('call [[c:12]] and [[lock:phone]]')]).toEqual([]) })
})

describe('A5 the diff', () => {
  it('inserting or removing one bullet shows one change, not a cascade', () => {
    expect(diffDocuments({ x: ['a b', 'c d', 'e f'] }, { x: ['new bullet here', 'a b', 'c d', 'e f'] }).map(c => [c.path, c.kind])).toEqual([['x.0', 'added']])
    const d = diffDocuments({ x: ['a b', 'c d', 'e f'] }, { x: ['a b', 'e f'] })
    expect(d.map(c => [c.path, c.kind])).toEqual([['x.1', 'removed']])
  })
  it('an edited bullet is "changed" at its new position and remembers its old one', () => {
    const d = diffDocuments({ x: ['one two three', 'four five six'] }, { x: ['inserted', 'one two THREE', 'four five six'] })
    expect(d).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'x.1', kind: 'changed', beforePath: 'x.0' }), expect.objectContaining({ path: 'x.0', kind: 'added' })]))
  })
  it('null and an empty string are the same thing; a text that became a list is still compared', () => {
    expect(diffDocuments({ a: null }, { a: '' })).toEqual([])
    expect(diffDocuments({ s: 'x' }, { s: ['x', 'y'] }).length).toBeGreaterThan(0)
  })
  it('keeps the old behaviour for text edits', () => { expect(wordDiff('a b', 'a c')).toEqual([{ t: 'eq', text: 'a ' }, { t: 'del', text: 'b' }, { t: 'ins', text: 'c' }]) })
})

describe('A5 what an expert reads of the customer\'s words', () => {
  const ctx = locks.maskingContext({ 'lock:name': 'Wanjiru Kamau', 'lock:email': 'w@example.com', 'lock:phone': '+254 712 345 678', 'lock:location': 'Nairobi, Kenya' })
  const posting = 'Company: Acme Corp\nAcme Corp builds things. ACME is hiring; Acme\'s team. Apply at careers.acme.com or jobs@acme.com'
  it('scrubs the brief, the answers, the revision note and the materials: contacts, the client\'s own details and the employer', () => {
    const v = view.presentForExpert({
      job: { revision_reason: 'Please use my number 0712 345 678 and my name Wanjiru' },
      brief: { targetRole: 'PM', story: 'I am Wanjiru Kamau, w@example.com, in Nairobi, Kenya. I want Acme Corp.', jobPosting: posting, topResults: [{ result: 'Grew users 40%' }] },
      questions: [{ id: 'q', body: 'Which role?', answer_body: 'Call me: +254 712 345 678' }], materials: [{ id: 'm', label: 'cv.pdf', text: 'Wanjiru Kamau, Nairobi, Kenya' }],
    }, ctx)
    const json = JSON.stringify(v)
    for (const secret of ['Wanjiru', 'Kamau', 'w@example.com', '712 345 678', 'Nairobi', 'Acme', 'ACME', 'careers.acme.com', 'jobs@acme.com']) expect(json, secret).not.toContain(secret)
    expect(v.brief.topResults[0].result).toBe('Grew users 40%'); expect(v.questions[0].id).toBe('q')
  })
  it('masks the employer whatever its case, its possessive and its short form', () => {
    expect(view.maskCompany('About Yahoo\nYahoo is hiring a Data Lead. Join YAHOO today. At yahoo you will lead; Yahoo\'s team.')).not.toMatch(/yahoo/i)
  })
})

describe('A5 settings limits', () => {
  it('a missing or malformed limit gets a safe default, so a limit can never be switched off', () => {
    const s = pilot.withLimitDefaults({ materials_max_bytes: 'big', question_max: 0 })
    expect(s).toMatchObject({ materials_max_files: 3, materials_max_bytes: 5 * 1048576, question_max: 3, question_answer_hours: 24 })
    expect(pilot.withLimitDefaults({ materials_max_files: 7 }).materials_max_files).toBe(7)
  })
})
