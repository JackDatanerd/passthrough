import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { getDesignTokens, resolveLook, presetFor, LATEST_LOOK, PRESETS, PRESET_BY_CATEGORY, PALETTES, FONTS } from '../src/services/design.service.js'
import { isSerifHeading } from '../src/lib/typeface.js'
import { scanRowToCamel } from '../src/lib/mappers.js'
import pdfTemplate from '../src/services/pdfTemplate.service.js'

// Signature document look (migration 0101). A document's colours and type are re-derived on every render, so the rules that
// derive them are versioned per scan: version 1 is the original free draw and must never change; version 2 is the presets.

const root = path.resolve(__dirname, '..')
const CATEGORIES = ['software_engineering', 'product_management', 'design', 'data_science', 'marketing', 'sales', 'operations', 'finance', 'healthcare', 'legal', 'education', 'other']

// WCAG relative luminance / contrast ratio.
const lum = hex => {
  const n = parseInt(hex.slice(1), 16)
  const f = c => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255)
}
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }

describe('version 1 is frozen: a scan delivered before the column renders exactly as it always did', () => {
  // Produced by the design.service.js that shipped before versioning (commit 40274ee). If one of these changes, a document
  // somebody already emailed to an employer would come back in different colours the next time it is regenerated.
  const GOLDEN = [
    ['u1', 's1', 'default', 'rose', 'classic'], ['u1', 's2', 'legal', 'slate', 'warm'],
    ['user-42', 'scan-9', 'software_engineering', 'wine', 'refined'], [null, 'anon-scan-1', 'finance', 'midnight', 'clean'],
    ['9f1c', '1b2e', 'healthcare', 'midnight', 'refined'], ['u7', 's3', 'design', 'rose', 'classic'],
    ['u7', 's4', 'operations', 'midnight', 'warm'], ['abc', 'def', 'education', 'navy', 'editorial'],
    [undefined, 'zzz', 'marketing', 'wine', 'classic'], ['u100', 's100', 'not-a-category', 'midnight', 'classic'],
    ['carl', 'scan-2026', 'data_science', 'violet', 'tech'], ['x', 'y', 'sales', 'forest', 'modern'],
  ]
  it.each(GOLDEN)('%s / %s / %s -> %s + %s', (u, s, industry, palette, font) => {
    for (const version of [undefined, null, 0, 1, '1', 'nonsense', 99]) {
      const t = getDesignTokens(u, s, industry, { version })
      expect([t.palette.id, t.fonts.id]).toEqual([palette, font])
      expect(t.version).toBeUndefined()      // a version-1 result keeps its original shape
    }
  })
  it('a call that names no version is version 1 (every caller from before the column)', () => {
    expect(getDesignTokens('u1', 's1', 'legal')).toEqual(getDesignTokens('u1', 's1', 'legal', { version: 1 }))
  })
})

describe('resolveLook', () => {
  it('keeps a known version and sends everything else to 1', () => {
    expect([1, 2, 3, '2', '1'].map(resolveLook)).toEqual([1, 2, 3, 2, 1])
    expect([undefined, null, 0, -1, LATEST_LOOK + 1, 1.5, NaN, 'x', {}].map(resolveLook)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1])
  })
})

describe('version 2: the signature presets', () => {
  const v2 = (u, s, industry, extra = {}) => getDesignTokens(u, s, industry, { version: 2, ...extra })

  it('every role category the app detects lands on a real preset, and an unknown one on the default', () => {
    for (const c of CATEGORIES) expect(Object.keys(PRESETS)).toContain(presetFor(c))
    for (const c of [undefined, null, '', 'default', 'not-a-category']) expect(presetFor(c)).toBe('professional')
    for (const preset of Object.values(PRESET_BY_CATEGORY)) expect(Object.keys(PRESETS)).toContain(preset)
  })
  it('the table covers every category ats.service.js can produce', () => {
    const src = fs.readFileSync(path.join(root, 'src/services/ats.service.js'), 'utf8')
    const block = src.slice(src.indexOf('const ROLE_SIGNALS = {'), src.indexOf('const ROLE_REGEXES'))
    const found = [...block.matchAll(/^\s{2}(\w+):\s*\[/gm)].map(m => m[1])
    expect(found.length).toBeGreaterThanOrEqual(11)
    for (const c of found) expect(PRESET_BY_CATEGORY, `role category ${c} has no preset`).toHaveProperty(c)
  })
  it('every preset uses real palettes and a real type pairing, and every ink reads clearly on its page', () => {
    for (const [id, p] of Object.entries(PRESETS)) {
      expect(FONTS.find(f => f.id === p.font), `${id} font`).toBeTruthy()
      expect(p.palettes.length).toBeGreaterThanOrEqual(3)
      for (const pid of p.palettes) {
        const pal = PALETTES.find(x => x.id === pid)
        expect(pal, `${id}: palette ${pid}`).toBeTruthy()
        expect(contrast(pal.primary, pal.bg), `${id}/${pid} heading ink`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(pal.text, pal.bg), `${id}/${pid} body ink`).toBeGreaterThanOrEqual(7)
      }
    }
  })
  it('the serif / sans character matches what each preset is for', () => {
    const serif = id => isSerifHeading(FONTS.find(f => f.id === PRESETS[id].font).heading)
    expect(serif('traditional')).toBe(true)
    expect(serif('creative')).toBe(true)
    expect(serif('professional')).toBe(false)
    expect(serif('modern')).toBe(false)
  })
  it('returns the preset, the version and the same shape the templates read', () => {
    const t = v2('u1', 's1', 'legal', { paper: 'a4' })
    expect(t).toMatchObject({ preset: 'traditional', version: 2, paper: 'a4' })
    expect(t.palette).toEqual(expect.objectContaining({ primary: expect.stringMatching(/^#[0-9A-F]{6}$/i), bg: expect.any(String), text: expect.any(String), accent: expect.any(String) }))
    expect(t.fonts).toEqual(expect.objectContaining({ heading: expect.any(String), body: expect.any(String), hPt: expect.any(Number), bPt: expect.any(Number) }))
  })
  it('a document only ever gets an ink from its own preset', () => {
    for (const c of CATEGORIES) for (let i = 0; i < 40; i++) {
      const t = v2(`user-${i}`, `scan-${i}`, c)
      expect(PRESETS[t.preset].palettes).toContain(t.palette.id)
      expect(t.fonts.id).toBe(PRESETS[t.preset].font)
    }
  })
  it('one person reads as one set: their id, not the scan, picks the ink inside a preset', () => {
    for (const c of CATEGORIES) {
      const inks = new Set(['s1', 's2', 's3', 'a-much-later-scan'].map(s => v2('person-1', s, c).palette.id))
      expect(inks.size).toBe(1)
    }
  })
  it('two people in one field do not all get the same colour', () => {
    for (const c of ['software_engineering', 'legal', 'design', 'healthcare']) {
      const inks = new Set(Array.from({ length: 60 }, (_, i) => v2(`person-${i}`, 's', c).palette.id))
      expect(inks.size, c).toBeGreaterThan(1)
    }
  })
  it('is deterministic, and a signed-out scan falls back to its own id', () => {
    expect(v2('u1', 's1', 'sales')).toEqual(v2('u1', 's1', 'sales'))
    expect(v2(null, 's1', 'sales')).toEqual(v2(undefined, 's1', 'sales'))
    expect(v2(null, 's1', 'sales').palette.id).toBe(v2('s1', 's1', 'sales').palette.id)
  })
  it('does not move with the posting text or the paper choice, only the paper itself', () => {
    const a = v2('u1', 's1', 'legal'), b = v2('u1', 's1', 'legal', { jdText: 'London programme organisation', paper: 'letter' })
    expect({ ...a, paper: null }).toEqual({ ...b, paper: null })
    expect(b.paper).toBe('letter')
  })
  it('both documents of a set render with the preset: the PDF carries its ink and its type', () => {
    const data = { name: 'Hannah Walker', email: 'a@b.co', summary: 'Counsel.', experience: [{ title: 'Associate', company: 'Firm', bullets: ['Won it.'] }] }
    const t = v2('u1', 's1', 'legal')
    const html = pdfTemplate.buildResumeHTML(data, t, null, { verified: false })
    expect(html).toContain(t.palette.primary)
    expect(html).toMatch(/h1 \{ font-family: "DocSerif"/)
    const m = pdfTemplate.buildResumeHTML(data, v2('u1', 's1', 'software_engineering'), null, { verified: false })
    expect(m).toMatch(/h1 \{ font-family: "DocSans"/)
  })
})

describe('the version a scan is rendered with comes from the scan', () => {
  it('scanRowToCamel reads the column, and a row from before it (or a database without it) is version 1', () => {
    expect(scanRowToCamel({ id: 'a', doc_template_version: 2 }).docTemplateVersion).toBe(2)
    expect(scanRowToCamel({ id: 'a', doc_template_version: 1 }).docTemplateVersion).toBe(1)
    expect(scanRowToCamel({ id: 'a' }).docTemplateVersion).toBe(1)
    expect(scanRowToCamel({ id: 'a', doc_template_version: null }).docTemplateVersion).toBe(1)
  })
  it('every render site in the scan controller passes the scan\'s version (a missed site would silently render version 1)', () => {
    const src = fs.readFileSync(path.join(root, 'src/controllers/scan.controller.js'), 'utf8')
    const calls = src.match(/designService\.getDesignTokens\([^\n]*\)/g) || []
    expect(calls.length).toBeGreaterThanOrEqual(7)
    for (const c of calls) expect(c, c).toMatch(/version: (scan|row)\.(docTemplateVersion|doc_template_version)/)
  })
  it('the profile download has no scan and keeps its neutral default look', () => {
    const src = fs.readFileSync(path.join(root, 'src/controllers/profile.controller.js'), 'utf8')
    expect(src).not.toMatch(/getDesignTokens\(/)
  })
})

describe('migration 0101 and design.service.js agree', () => {
  const dir = path.join(root, 'supabase/migrations')
  const sql = fs.readdirSync(dir).filter(f => /doc_template_version/.test(fs.readFileSync(path.join(dir, f), 'utf8'))).sort()
    .map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n')
  it('adds the column with 1 for every existing scan and makes the NEW default the latest look', () => {
    expect(sql).toMatch(/add column if not exists doc_template_version smallint not null default 1/)
    const defaults = [...sql.matchAll(/alter column doc_template_version set default (\d+)/g)].map(m => Number(m[1]))
    expect(defaults.at(-1)).toBe(LATEST_LOOK)
  })
  it('the check constraint allows exactly the versions the code knows', () => {
    const all = [...sql.matchAll(/doc_template_version between 1 and (\d+)/g)].map(m => Number(m[1]))
    expect(all.at(-1)).toBe(LATEST_LOOK)
  })
  it('the column is accounted for in the migration/mapper ledger (internal, never sent to the browser)', () => {
    const src = fs.readFileSync(path.join(root, 'src/lib/mappers.js'), 'utf8')
    expect(src).toMatch(/docTemplateVersion:\s+row\.doc_template_version \?\? 1/)
    const serverOnly = src.slice(src.indexOf('const SERVER_ONLY_SCAN_FIELDS = ['), src.indexOf('const CLIENT_SCAN_FIELDS = ['))
    const clientList = src.slice(src.indexOf('const CLIENT_SCAN_FIELDS = ['), src.indexOf('// Allow-list: only CLIENT_SCAN_FIELDS'))
    expect(serverOnly).toMatch(/'docTemplateVersion'/)
    expect(clientList).not.toMatch(/docTemplateVersion/)
  })
})
