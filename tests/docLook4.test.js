import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { getDesignTokens, LATEST_LOOK, normalizeMarks, MARK_KEYS } from '../src/services/design.service.js'
import pdfTemplate from '../src/services/pdfTemplate.service.js'
import { signatureFit, COLOPHON } from '../src/lib/docFit.js'
import { tileCoverage, renderBadgePng, renderSharePng } from '../src/lib/badgePng.js'
import { renderBadge } from '../src/controllers/verify.controller.js'
import { renderQrInline } from '../src/lib/qr.js'

// Document look 4 (migration 0126): the hallmark tile + owner-selectable marks. Look 3 must stay byte-for-byte what it was.

const URL_ = 'https://passthrough.dev/verify/ABC123'
const sha = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16)
const BUL = 'Led migration of the settlement engine to an event-driven design, processing 2.4M transactions daily with zero downtime across three regions.'
const resume = (jobs = 2, bullets = 2) => ({
  name: 'Hannah Walker', email: 'hannah.walker@example.com', phone: '+1 415 555 0132', location: 'Austin, TX', linkedin: 'linkedin.com/in/hannahwalker',
  summary: 'Senior backend engineer with 8 years building payment and identity platforms.',
  experience: Array.from({ length: jobs }, (_, i) => ({ title: i ? 'Engineer' : 'Staff Engineer', company: i ? 'Kopa' : 'Payfast', location: 'Austin', dates: i ? '2019 – 2023' : '2023 – Present', bullets: Array.from({ length: bullets }, () => BUL) })),
  education: [{ degree: 'BSc Computer Science', institution: 'University of Leeds', dates: '2014 – 2018' }],
  skills: ['Node.js', 'PostgreSQL', 'Kafka'], certifications: ['AWS SA'],
})
const CAT = { traditional: 'legal', professional: 'healthcare', modern: 'software_engineering', creative: 'design' }
const html = (preset, marks, { verified = true, version = 4, data = resume() } = {}) =>
  pdfTemplate.buildResumeHTML(data, getDesignTokens('person-1', 's1', CAT[preset], { version, marks }), URL_, { verified })
const ON = { header: true, colophon: true, footer: true }
const OFF = { header: false, colophon: false, footer: false }

describe('look 3 is frozen', () => {
  // sha256 of look-3 output taken from the tree BEFORE look 4 existed: [verified resume, unverified resume, cover letter].
  const GOLD = {
    traditional: ['580fb5ab126a8870', '82062ee30511adff', 'a96fe6ca579eb281'], professional: ['9fd57eee5e61b1b1', '50b781aa5a734bd4', '46253e9fa396e895'],
    modern: ['30448a3b5f78e8d7', '2e7ea6bf5ef0c2ee', '7df6c26c3b9e72d5'], creative: ['7797d447c56d9d3e', 'be94344a2bf58d3b', 'a53957ddfffa345f'],
  }
  const b = BUL
  const data = {
    name: 'Hannah Walker', email: 'hannah.walker@example.com', phone: '+1 415 555 0132', location: 'Austin, TX', linkedin: 'linkedin.com/in/hannahwalker',
    summary: 'Senior backend engineer with 8 years building payment and identity platforms.',
    experience: [{ title: 'Staff Engineer', company: 'Payfast', location: 'Austin', dates: '2023 – Present', bullets: [b, b] }, { title: 'Engineer', company: 'Kopa', dates: '2019 – 2023', bullets: [b] }],
    education: [{ degree: 'BSc Computer Science', institution: 'University of Leeds', dates: '2014 – 2018' }], skills: ['Node.js', 'PostgreSQL', 'Kafka'], certifications: ['AWS SA'],
  }
  it.each(Object.keys(CAT))('%s', preset => {
    const t = getDesignTokens('person-1', 's1', CAT[preset], { version: 3, marks: ON })   // marks passed on purpose: look 3 must ignore them
    expect(t.marks).toBeUndefined()
    expect(sha(pdfTemplate.buildResumeHTML(data, t, URL_, { verified: true }))).toBe(GOLD[preset][0])
    expect(sha(pdfTemplate.buildResumeHTML(data, t, URL_, { verified: false }))).toBe(GOLD[preset][1])
    expect(sha(pdfTemplate.buildCoverLetterHTML('Dear Hiring Manager,\n\nI am applying.\n\nSincerely,\nHannah', data, t, { date: 'October 20, 2026' }))).toBe(GOLD[preset][2])
  })
})

describe('marks', () => {
  it('LATEST_LOOK is 4 and the tokens carry normalised marks only from look 4', () => {
    expect(LATEST_LOOK).toBe(4)
    expect(getDesignTokens('u', 's', 'legal', { version: 4 }).marks).toEqual(ON)
    expect(getDesignTokens('u', 's', 'legal', { version: 4, marks: { footer: false } }).marks).toEqual({ header: true, colophon: true, footer: false })
  })
  it('normalizeMarks: missing, partial, junk are on; only an explicit false turns one off', () => {
    expect(MARK_KEYS).toEqual(['header', 'colophon', 'footer'])
    for (const v of [undefined, null, {}, 'x', 5, []]) expect(normalizeMarks(v)).toEqual(ON)
    expect(normalizeMarks({ header: false, colophon: 'no', extra: false })).toEqual({ header: false, colophon: true, footer: true })
  })
  it.each(Object.keys(CAT))('%s: every mark appears when on, none when off', preset => {
    const on = html(preset, ON), off = html(preset, OFF)
    expect(on).toContain('class="seal'); expect(on).toContain('class="colophon'); expect(on).toMatch(/Passthrough Verified\s+\\00B7\s+ABC123/)
    expect(off).not.toContain('class="seal'); expect(off).not.toContain('class="colophon'); expect(off).not.toMatch(/Passthrough Verified|Passthrough Scan Report/)
    expect(off).not.toContain(URL_)
  })
  it('each mark is independent', () => {
    const only = k => html('professional', { ...OFF, [k]: true })
    expect(only('header')).toContain('class="seal'); expect(only('header')).not.toContain('class="colophon')
    expect(only('colophon')).toContain('class="colophon'); expect(only('colophon')).not.toContain('class="seal')
    expect(only('footer')).toMatch(/Passthrough Verified\s+\\00B7\s+ABC123/); expect(only('footer')).not.toContain('class="seal')
  })
  it.each(Object.keys(CAT))('%s: the gold check is drawn only for a verified page', preset => {
    expect(html(preset, ON, { verified: true })).toContain('#FFE27A')
    const nv = html(preset, ON, { verified: false })
    expect(nv).not.toContain('#FFE27A'); expect(nv).toContain('#6B7280'); expect(nv).toContain('Passthrough Scan Report'); expect(nv).not.toContain('rx="8" fill="#1E40AF"'); expect(nv).not.toContain('class="t">Passthrough Verified')
  })
  it('the proof block carries a QR and says a copy must be checked on the page (it does not claim the code proves the file)', () => {
    const h = html('modern', ON)
    expect(h).toContain('<svg class="qr"')
    expect(h).toMatch(/Check a file/)
    expect(h).not.toMatch(/proves|guarantee/i)
  })
})

describe('signatureFit: the proof block never makes a page of its own', () => {
  it('a short resume gets the full block; a nearly full page gets the line or nothing; off means off', () => {
    expect(signatureFit(resume(1, 2), 'a4', { colophon: true }).tier).toBe('full')
    expect(signatureFit(resume(1, 2), 'a4', { colophon: false }).tier).toBeNull()
    const tiers = [1, 2, 3, 4, 5].map(n => signatureFit(resume(n, 3), 'a4', { colophon: true }).tier)
    for (const t of tiers) expect(['full', 'line', null]).toContain(t)
    expect(tiers.some(t => t !== 'full')).toBe(true)   // a page that is nearly full does not get the big block
    expect(COLOPHON.full).toBeGreaterThan(COLOPHON.line)
  })
})

describe('the tile everywhere', () => {
  it('tileCoverage: check pixels only when verified', () => {
    for (const cut of ['compact', 'full']) {
      expect(tileCoverage(64, { cut, verified: true }).includes(3)).toBe(true)
      expect(tileCoverage(64, { cut, verified: false }).includes(3)).toBe(false)
    }
  })
  it('SVG badge: tile + check only for Passthrough Verified', () => {
    expect(renderBadge('Passthrough Verified', '92/100 unmodified', '#15803d')).toContain('#FFE27A')
    expect(renderBadge('Passthrough', 'scan 71/100', '#6b7280')).not.toContain('#FFE27A')
    expect(renderBadge('Passthrough', 'revoked', '#b91c1c')).not.toContain('#FFE27A')
  })
  it('PNG badge and card are valid 4-bit PNGs', () => {
    for (const png of [renderBadgePng('Passthrough Verified', '92/100 unmodified', '#15803d'), renderBadgePng('Passthrough', 'scan 71/100'),
      renderSharePng({ headline: 'PASSTHROUGH VERIFIED', big: '92/100', mark: 'verified' }), renderSharePng({ headline: 'PASSTHROUGH', mark: 'neutral' }), renderSharePng({ headline: 'X' })]) {
      expect(Buffer.from(png.subarray(0, 8)).toString('hex')).toBe('89504e470d0a1a0a')
      expect(png[24]).toBe(4)
    }
  })
  it('the inline QR is decorative and has a quiet zone', () => {
    const s = renderQrInline(URL_)
    expect(s).toContain('aria-hidden="true"'); expect(s).toContain('<svg')
  })
})

describe('migration 0126 and look 4 agree', () => {
  const sql = fs.readFileSync(new URL('../supabase/migrations/0126_doc_look_4_marks.sql', import.meta.url), 'utf8')
  it('default version, check range and ledger row', () => {
    expect(sql).toMatch(new RegExp(`doc_template_version set default ${LATEST_LOOK};`))
    expect(sql).toMatch(new RegExp(`between 1 and ${LATEST_LOOK}\\)`))
    expect(sql).toContain("(126, '0126_doc_look_4_marks')")
  })
  it('the controller passes marks at every delivered-resume token site (cover letters deliberately do not)', () => {
    const src = fs.readFileSync(new URL('../src/controllers/scan.controller.js', import.meta.url), 'utf8')
    expect((src.match(/marks: scan\.docMarks/g) || []).length).toBe(5)
  })
})
