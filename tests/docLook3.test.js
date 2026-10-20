import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import { getDesignTokens, LATEST_LOOK, PRESETS } from '../src/services/design.service.js'
import pdfTemplate from '../src/services/pdfTemplate.service.js'
import pdfSignature from '../src/services/pdfSignature.service.js'
import { estimateLoad, densityFor, capacityFor, airinessFor, SQUEEZE_LIMIT } from '../src/lib/docFit.js'

// Document look 3 (migration 0102): the signature PDF skeleton, pdfSignature.service.js. Looks 1 and 2 stay on the original skeleton.

const URL_ = 'https://passthrough.dev/verify/ABC123'
const sha = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16)
const BUL = 'Led migration of the settlement engine to an event-driven design, processing 2.4M transactions daily with zero downtime across three regions.'
const resume = (jobs = 2, bullets = 2, extra = {}) => ({
  name: 'Amina Otieno', email: 'amina.otieno@example.com', phone: '+254 712 345 678', location: 'Nairobi, Kenya', linkedin: 'linkedin.com/in/aminaotieno',
  summary: 'Senior backend engineer with 8 years building payment and identity platforms.',
  experience: Array.from({ length: jobs }, (_, i) => ({ title: i ? 'Engineer' : 'Staff Engineer', company: i ? 'Kopa' : 'Payfast', location: 'Nairobi', dates: i ? '2019 – 2023' : '2023 – Present', bullets: Array.from({ length: bullets }, () => BUL) })),
  education: [{ degree: 'BSc Computer Science', institution: 'University of Nairobi', dates: '2014 – 2018' }],
  skills: ['Node.js', 'PostgreSQL', 'Kafka'], certifications: ['AWS SA'], ...extra,
})
const CAT = { traditional: 'legal', professional: 'healthcare', modern: 'software_engineering', creative: 'design' }
const tok = (preset, extra = {}) => ({ ...getDesignTokens('person-1', 's1', CAT[preset], { version: 3 }), ...extra })
const render = (preset, data = resume(), opts = {}, extra = {}) => pdfTemplate.buildResumeHTML(data, tok(preset, extra), URL_, { verified: true, ...opts })
const text = html => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&middot;|&nbsp;/g, ' ').replace(/\s+/g, ' ')

describe('looks 1 and 2 render exactly as they were delivered', () => {
  // sha256 of the HTML produced by pdfTemplate.service.js BEFORE look 3 existed (commit 4da7fee). If one changes, a PDF somebody already
  // emailed would come back different the next time it is regenerated.
  const b = BUL
  const data = {
    name: 'Amina Otieno', email: 'amina.otieno@example.com', phone: '+254 712 345 678', location: 'Nairobi, Kenya', linkedin: 'linkedin.com/in/aminaotieno',
    summary: 'Senior backend engineer with 8 years building payment and identity platforms.',
    experience: [{ title: 'Staff Engineer', company: 'Payfast', location: 'Nairobi', dates: '2023 – Present', bullets: [b, b] }, { title: 'Engineer', company: 'Kopa', dates: '2019 – 2023', bullets: [b] }],
    education: [{ degree: 'BSc Computer Science', institution: 'University of Nairobi', dates: '2014 – 2018' }], skills: ['Node.js', 'PostgreSQL', 'Kafka'], certifications: ['AWS SA'],
  }
  const letter = 'Dear Hiring Manager,\n\nI am applying.\n\nSincerely,\nAmina'
  it.each([[1, '2e971d0b8b4eea47', '5e9dd729dd5761b2'], [2, 'dbe6c7cd793dff09', '771caee0668eedb5']])('look %i', (version, r, l) => {
    const t = getDesignTokens('u1', 's1', 'legal', { version })
    expect(sha(pdfTemplate.buildResumeHTML(data, t, URL_, { verified: true }))).toBe(r)
    expect(sha(pdfTemplate.buildCoverLetterHTML(letter, data, t, { date: 'October 20, 2026' }))).toBe(l)
  })
  it('tokens that name no version (the saved-profile download) stay on the original skeleton', () => {
    expect(pdfTemplate.buildResumeHTML(resume(), { paper: 'a4' }, URL_, {})).toContain('body::before')
  })
  it('only look 3 and later reach the signature skeleton', () => {
    expect(render('professional')).not.toContain('body::before')
    expect(render('professional')).toContain('<header class="top">')
    expect(pdfTemplate.buildResumeHTML(resume(), getDesignTokens('u', 's', 'legal', { version: 2 }), URL_, {})).toContain('body::before')
  })
  it('the design service names look 3 in the tokens, with the same ink a person already had under look 2', () => {
    expect(LATEST_LOOK).toBe(3)
    for (const c of Object.values(CAT)) {
      const two = getDesignTokens('person-9', 'sx', c, { version: 2 }), three = getDesignTokens('person-9', 'sx', c, { version: 3 })
      expect(three).toMatchObject({ version: 3, preset: two.preset })
      expect(three.palette).toEqual(two.palette)
      expect(three.fonts).toEqual(two.fonts)
    }
  })
})

describe('the signature resume', () => {
  it.each(Object.keys(CAT))('%s: real text in reading order, one column, nothing a parser would scramble', preset => {
    const html = render(preset)
    expect(html).not.toMatch(/<(table|img|canvas|iframe|script|object|embed|svg(?![^>]*class="ck"))/i)
    expect(html).not.toMatch(/url\((?!["']?data:)/i)                       // no remote resource
    const t = text(html)
    expect(t.indexOf('Amina Otieno')).toBeLessThan(t.indexOf('amina.otieno@example.com'))
    expect(t.indexOf('amina.otieno@example.com')).toBeLessThan(t.indexOf('Passthrough Verified'))
    expect(t.indexOf('Staff Engineer')).toBeLessThan(t.indexOf('Payfast'))
    expect(t.indexOf('Payfast')).toBeLessThan(t.indexOf('2023 – Present'))
    expect(t.indexOf('Summary')).toBeLessThan(t.indexOf('Experience'))
    expect(t.indexOf('Experience')).toBeLessThan(t.indexOf('Education'))
    expect(t.indexOf('Education')).toBeLessThan(t.indexOf('Skills'))
  })
  it('the credential is a designed seal with the address printed in it, and honest when the score is not Verified', () => {
    const v = render('modern')
    expect(v).toMatch(/<a class="seal" href="https:\/\/passthrough\.dev\/verify\/ABC123">/)
    expect(text(v)).toContain('Passthrough Verified')
    expect(v).toContain('passthrough.dev/verify/ABC123')
    const nv = render('modern', resume(), { verified: false })
    expect(nv).toContain('class="seal plain"')
    expect(text(nv)).toContain('Passthrough Scan Report')
    expect(text(nv)).not.toContain('Passthrough Verified')
    const none = pdfTemplate.buildResumeHTML(resume(), tok('modern'), null, {})
    expect(none).not.toContain('class="seal')
  })
  it('role, employer and dates are three levels; the employer falls back sensibly', () => {
    const html = render('professional')
    expect(html).toMatch(/<span class="role">Staff Engineer<\/span><span class="org">Payfast<span class="loc"> &middot; Nairobi<\/span><\/span><span class="dates">2023 – Present<\/span>/)
    const only = render('professional', resume(1, 1, { experience: [{ company: 'Solo Co', location: 'Remote', bullets: ['Did it.'] }] }))
    expect(only).toMatch(/<span class="role">Solo Co<\/span><span class="org"><span class="loc">Remote<\/span><\/span>/)
  })
  it('the four presets are four designs on one skeleton, not one design in four colours', () => {
    const html = Object.fromEntries(Object.keys(CAT).map(p => [p, render(p)]))
    expect(html.traditional).toMatch(/border-bottom: 3px double/)
    expect(html.modern).toMatch(/border-top: 4px solid/)
    expect(html.modern).toMatch(/h2::before/)
    expect(html.creative).toMatch(/h1::after/)
    expect(html.professional).toMatch(/h2::after \{[^}]*width: 30pt/)
    expect(new Set(Object.values(html).map(h => h.match(/<style>[\s\S]*<\/style>/)[0])).size).toBe(4)
    for (const p of ['traditional', 'creative']) expect(html[p]).toMatch(/h1 \{[^}]*"DocSerif"/)
    for (const p of ['professional', 'modern']) expect(html[p]).toMatch(/h1 \{[^}]*"DocSans"/)
    expect(Object.keys(PRESETS).sort()).toEqual(Object.keys(CAT).sort())
  })
  it('an unknown preset falls back to the professional design', () => {
    const t = { ...tok('professional'), preset: 'nonsense' }
    expect(pdfTemplate.buildResumeHTML(resume(), t, URL_, {})).toMatch(/h2::after/)
  })
  it('escapes everything the person typed, and never prints a non-web link', () => {
    const evil = resume(1, 1, { name: '<script>alert(1)</script>', experience: [{ title: '"><img src=x onerror=1>', company: '</style><b>x', bullets: ['<script>1</script> & more'] }], skills: ['<i>x</i>'] })
    const html = pdfTemplate.buildResumeHTML(evil, tok('creative'), 'javascript:alert(1)', {})
    expect(html).not.toMatch(/<script|<img src=x|<b>x|<i>x/)
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('class="seal')                                   // a javascript: address is not a credential link
  })
  it('survives empty, partial and hostile data', () => {
    for (const d of [{}, null, undefined, { name: 'A' }, { experience: [null, {}, { bullets: [null, '', 5] }], skills: [null, 3] }, { education: 'x', experience: 'y' }])
      for (const p of Object.keys(CAT)) expect(() => pdfTemplate.buildResumeHTML(d, tok(p), URL_, {})).not.toThrow()
    expect(pdfTemplate.buildResumeHTML({}, tok('modern'), null, {})).toContain('<html')
  })
  it('with no job history the strongest evidence leads, as in the Word file', () => {
    const t = text(render('professional', { name: 'Sam', education: [{ degree: 'BSc', institution: 'UoN' }], projects: [{ name: 'Ledger', description: 'A library.' }], skills: ['Go'] }))
    expect(t.indexOf('Education')).toBeLessThan(t.indexOf('Projects'))
    expect(t.indexOf('Projects')).toBeLessThan(t.indexOf('Skills'))
  })
  it('a short resume is given room, a full one is not, and a resume just over a page is tightened', () => {
    const h2 = html => Number(/h2 \{[^}]*margin: ([\d.]+)pt/.exec(html)[1])
    const sparse = h2(render('professional', resume(1, 1))), dense = h2(render('professional', resume(3, 4)))
    expect(sparse).toBeGreaterThan(dense)
    let over
    for (let b = 1; b < 12 && !over; b++) { const d = resume(2, b); const l = estimateLoad(d, 3); if (l > capacityFor('a4', 'pdf', 3) && l <= capacityFor('a4', 'pdf', 3) * 1.12) over = d }
    expect(over).toBeTruthy()
    expect(render('professional', over, {}, { paper: 'a4' })).toMatch(/line-height: 1\.38/)
    expect(render('professional', resume(1, 1), {}, { density: 'compact' })).toMatch(/line-height: 1\.38/)   // a forced density is honoured
  })
  it('prints the continuation-page footer with the name, safely', () => {
    expect(render('modern')).toMatch(/@bottom-center \{ content: "Amina Otieno  \\00B7  Page " counter\(page\) " of " counter\(pages\)/)
    // A hostile name stays inside ONE string literal (no quote, backslash or angle bracket can close it or start a tag).
    const content = /@bottom-center \{ content: (.*?); font:/.exec(render('modern', resume(1, 1, { name: 'A"; } body { display:none } /*\\" <b>' })))[1]
    expect(content).toMatch(/^"[^"\\<>&]*\\00B7  Page " counter\(page\) " of " counter\(pages\)$/)
  })
  it('A4 and Letter set the page size', () => {
    expect(render('modern', resume(), {}, { paper: 'a4' })).toMatch(/size: A4/)
    expect(render('modern', resume(), {}, { paper: 'letter' })).toMatch(/size: Letter/)
  })
})

describe('the signature cover letter', () => {
  const letter = 'Dear Hiring Manager,\n\nI am applying for the role.\nSecond line.\n\nSincerely,\nAmina'
  it.each(Object.keys(CAT))('%s: the same letterhead, no credential seal, paragraphs kept', preset => {
    const html = pdfTemplate.buildCoverLetterHTML(letter, resume(), tok(preset), { date: 'October 20, 2026' })
    expect(html).toContain('<header class="top">')
    expect(html).not.toContain('class="seal')
    expect(html).toContain('October 20, 2026')
    expect(html.match(/<p class="block">/g)).toHaveLength(3)
    expect(html).toContain('I am applying for the role.<br>Second line.')
    expect(html).not.toMatch(/<(table|img|script)/i)
  })
  it('escapes the letter and the name', () => {
    const html = pdfTemplate.buildCoverLetterHTML('<script>x</script>', { name: '<b>A</b>' }, tok('modern'), {})
    expect(html).not.toMatch(/<script|<b>A/)
  })
  it('survives no data', () => {
    expect(() => pdfTemplate.buildCoverLetterHTML('', null, tok('modern'), {})).not.toThrow()
    expect(() => pdfTemplate.buildCoverLetterHTML(undefined, {}, tok('traditional'), { date: null })).not.toThrow()
  })
  it('looks 1 and 2 keep their original letter', () => {
    expect(pdfTemplate.buildCoverLetterHTML(letter, resume(), getDesignTokens('u', 's', 'legal', { version: 2 }), {})).toContain('body::before')
  })
})

describe('docFit: look 3 has its own measured capacity and the original numbers are untouched', () => {
  it('the original estimate and capacity are what they were', () => {
    expect(estimateLoad(resume(2, 3))).toBeCloseTo(estimateLoad(resume(2, 3), 1), 6)
    expect(estimateLoad({ name: 'A', summary: 'Senior engineer. '.repeat(8).trim(), experience: [{ title: 'T', company: 'C', bullets: [BUL, BUL, BUL] }, { title: 'T', company: 'C', bullets: [BUL, BUL, BUL] }], education: [{ degree: 'B', institution: 'U' }], skills: ['a', 'b'], certifications: ['x'] })).toBeCloseTo(37.4, 6)
    expect(capacityFor('a4', 'pdf')).toBe(48)
    expect(capacityFor('a4', 'docx')).toBe(58.5)
    expect(capacityFor('a4', 'docx', 3)).toBe(58.5)                       // the Word file is not part of look 3
  })
  it('look 3 prints two lines per entry head and a taller header, so the same resume weighs more', () => {
    for (const [j, b] of [[1, 2], [2, 3], [3, 4]]) expect(estimateLoad(resume(j, b), 3)).toBeGreaterThan(estimateLoad(resume(j, b), 1))
    expect(estimateLoad({}, 3)).toBe(0 + 4.4)
  })
  it('letter holds less than A4', () => {
    expect(capacityFor('letter', 'pdf', 3)).toBeCloseTo(capacityFor('a4', 'pdf', 3) * 0.935, 6)
  })
  it('densityFor tightens only a resume just over a page, for look 3 and for the original', () => {
    const cap = capacityFor('a4', 'pdf', 3)
    const by = f => { for (let b = 1; b < 14; b++) for (let j = 1; j < 6; j++) { const d = resume(j, b), l = estimateLoad(d, 3); if (f(l, cap)) return d } }
    const under = by((l, c) => l < c * 0.9), over = by((l, c) => l > c && l <= c * 1.12), far = by((l, c) => l > c * 1.2)
    expect([densityFor(under, 'a4', 'pdf', 3), densityFor(over, 'a4', 'pdf', 3), densityFor(far, 'a4', 'pdf', 3)]).toEqual(['normal', 'compact', 'normal'])
    expect(SQUEEZE_LIMIT.pdf).toBe(1.17)                                   // the original limit is unchanged
  })
  it('airiness: 1 once a page is mostly full, up to 1.3 for an almost empty one, never decreasing as the page empties', () => {
    expect(airinessFor(45, 48)).toBe(1)
    expect(airinessFor(0.85 * 48, 48)).toBe(1)
    expect(airinessFor(10, 48)).toBe(1.3)
    let prev = 1
    for (let l = 48; l >= 8; l -= 2) { const a = airinessFor(l, 48); expect(a).toBeGreaterThanOrEqual(prev); expect(a).toBeLessThanOrEqual(1.3); prev = a }
    for (const bad of [[NaN, 48], [10, 0], [undefined, undefined]]) expect(airinessFor(...bad)).toBe(1)
  })
})

describe('the signature helpers are the template\'s own (one escaping function)', () => {
  it('exports the builders', () => {
    expect(typeof pdfSignature.buildSignatureResumeHTML).toBe('function')
    expect(pdfSignature.PRESET_IDS.sort()).toEqual(Object.keys(PRESETS).sort())
  })
})
