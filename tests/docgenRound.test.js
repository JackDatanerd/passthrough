// Prompts + documents round: month-precise years, canonical dates, finance-safe buzzword rule, acronym pairing, skill matching,
// plain-text export, sampling temperatures, document metadata and link ink.
import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { yearsFromText, careerFacts } = require('../src/lib/careerFacts')
const { canonDates } = require('../src/lib/dateFormat')
const { wordsRegex, BUZZ_WORDS, BULLET_WORDS } = require('../src/prompts/constants')
const { pairAcronyms } = require('../src/lib/skillAliases')
const { readerQuality } = require('../src/lib/readerQuality')
const { resumeToPlainText } = require('../src/lib/plainText')
const { findRewriteStyleProblems } = require('../src/lib/rewriteStyle')
const { generateAtsDocx } = require('../src/services/docx.service')
const JSZip = require('jszip')
const NOW = new Date('2026-10-22T12:00:00Z')

describe('years of experience are counted in months where the dates name them', () => {
  it.each([
    ['Analyst Jan 2020 – Dec 2022', 3], ['Analyst Jan 2022 – Dec 2022', 1], ['Analyst Mar 2019 – Feb 2022', 3],
    ['Analyst 06/2019 – 08/2022', 3], ['2019-06 to 2022-08', 3], ['Analyst Jan 2020 – Present', 6], ['Analyst 2019 – 2022', 3],
    ['Analyst Jan 2018 – Jun 2019\nManager Sep 2019 – Dec 2021', 3],
  ])('%j -> %i', (t, y) => expect(yearsFromText(t, NOW)).toBe(y))
  it('never reads an education range as work, and never counts the future', () => {
    expect(yearsFromText('BSc 2015 - 2019', NOW)).toBeNull()
    expect(yearsFromText('Analyst Jan 2025 – Dec 2030', NOW)).toBe(1)
  })
  it('careerFacts agrees with the text reader', () => {
    expect(careerFacts({ experience: [{ dates: 'Jan 2020 – Dec 2022' }] }, NOW).years).toBe(3)
    expect(careerFacts({ experience: [{ dates: '2019 – 2022' }, { dates: '06/2023 - Present' }] }, NOW).years).toBe(6)
  })
})

describe('dates are canonicalised by format only', () => {
  it.each([
    ['January 2020 - current', 'Jan 2020 – Present'], ['01/2020 to now', 'Jan 2020 – Present'], ['2020-01 – 2022-06', 'Jan 2020 – Jun 2022'],
    ['Sept. 2019 – Dec 2021', 'Sep 2019 – Dec 2021'], ['2019-21', '2019 – 2021'], ['2019', '2019'], ['Jan 2020 – Present', 'Jan 2020 – Present'],
  ])('%j -> %j', (a, b) => expect(canonDates(a)).toBe(b))
  it.each(['Summer 2019', "'19 - '21", '2021 – 2019', '12/03/2019', 'Fall 2020 – May 2021', ''])('leaves %j exactly as written', s => expect(canonDates(s)).toBe(s))
})

describe('"leverage" is only a buzzword outside finance', () => {
  const B = wordsRegex(BUZZ_WORDS)
  it.each(['leveraged my skills to win', 'Leveraging data to grow'])('flags %j', s => expect(B.test(s)).toBe(true))
  it.each(['Modeled leveraged buyout scenarios', 'Managed leverage ratios', 'Built models for leveraged finance deals', 'Analysed financial leverage'])('allows %j', s => expect(B.test(s)).toBe(false))
  it('the rewrite guard keeps a finance term of art', () => {
    expect(findRewriteStyleProblems({ experience: [{ bullets: ['Did LBO models'] }] }, { experience: [{ bullets: ['Modeled leveraged buyout scenarios for six sponsor-backed deals.'] }] })).toEqual([])
  })
})

describe('bullet length has one limit', () => {
  it('the ATS craft signal uses the guard limit, not its own', () => {
    const src = require('node:fs').readFileSync(require.resolve('../src/services/ats.service.js'), 'utf8')
    expect(src).not.toMatch(/length > 35/)
    expect(src).toContain('BULLET_WORDS.guard')
    expect(BULLET_WORDS.guard).toBeGreaterThanOrEqual(BULLET_WORDS.prompt)
  })
})

describe('acronym + expansion pairs', () => {
  const jd = 'We need Search Engine Optimization and CRM experience.'
  it('writes "Long (SHORT)" when the posting uses either form', () => {
    expect(pairAcronyms(['SEO', 'SQL', 'crm'], jd)).toEqual(['Search Engine Optimization (SEO)', 'SQL', 'Customer Relationship Management (CRM)'])
  })
  it('merges both forms listed separately into one entry, and leaves skills the posting never mentions alone', () => {
    expect(pairAcronyms(['SEO', 'Search Engine Optimization', 'ML'], jd)).toEqual(['Search Engine Optimization (SEO)', 'ML'])
  })
  it('is idempotent and adds nothing', () => {
    const once = pairAcronyms(['SEO'], jd)
    expect(pairAcronyms(once, jd)).toEqual(once)
    expect(pairAcronyms(['Python'], jd)).toEqual(['Python'])
  })
})

describe('reader quality matches whole skill words', () => {
  it('"R" is not shown by the letter r in "report"', () => {
    const base = { summary: 'x', experience: [{ bullets: ['Built dashboards for the finance team with 3 stakeholders weekly.'] }] }
    expect(readerQuality({ ...base, skills: ['R'] })).toBe(readerQuality({ ...base, skills: ['Rust'] }))
    expect(readerQuality({ ...base, skills: ['dashboards'] })).toBeGreaterThan(readerQuality({ ...base, skills: ['R'] }))
  })
})

describe('plain-text export', () => {
  it('is paste-ready: canonical dates, "- " bullets, comma skills, Experience first', () => {
    const t = resumeToPlainText({ name: 'W M', email: 'w@e.com', experience: [{ title: 'Analyst', company: 'Acme', dates: '01/2020 to now', bullets: ['• Did x'] }], skills: ['SQL', 'Python'] })
    expect(t).toBe('W M\nw@e.com\n\nEXPERIENCE\nAnalyst - Acme | Jan 2020 – Present\n- Did x\n\nSKILLS\nSQL, Python\n')
  })
  it('survives garbage', () => { expect(resumeToPlainText(null)).toBe('\n'); expect(resumeToPlainText({ experience: 'x', skills: [1, null] })).toBeTypeOf('string') })
})

describe('the DOCX', () => {
  const data = { name: 'Emily Carter', email: 'w@example.com', experience: [{ title: 'Analyst', company: 'Acme', dates: 'January 2020 - current', bullets: ['Built things.'] }], skills: ['SQL', 'Python'] }
  const parts = async b => { const z = await JSZip.loadAsync(b); return { doc: await z.file('word/document.xml').async('string'), core: await z.file('docProps/core.xml').async('string') } }
  it('prints canonical dates and comma-separated skills', async () => {
    const { doc } = await parts(await generateAtsDocx(data, null))
    expect(doc).toContain('Jan 2020 – Present')
    expect(doc).toContain('SQL, Python')
  })
  it('carries no tool name or marketing line in its properties', async () => {
    const { core } = await parts(await generateAtsDocx(data, null))
    expect(core).not.toMatch(/ATS-friendly/)
    expect(core).toMatch(/<cp:lastModifiedBy>Emily Carter</)
  })
})
