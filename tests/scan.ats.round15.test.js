// Scan / ATS round 15 (independent pass over claude.service / claimGuard, and a review of round 14):
// - the claim guard failed the paid rewrite for any resume naming Node.js / Next.js / Vue.js;
// - its word stem treated "excellent" as the tool Excel (and "sparked" as Spark, "expressed" as Express), in both directions;
// - the provisional-score re-check could be fired twice at once (two AI calls, two result emails).
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import claimGuard from '../src/lib/claimGuard.js'

const mk = (src, bullet) => claimGuard.findClaimProblems(
  { experience: [{ company: 'Acme', title: 'Developer', bullets: [src] }] },
  { experience: [{ company: 'Acme', title: 'Developer', bullets: [bullet] }] }, { source: src })

describe('B1 - dotted tool names the resume already uses are not "invented"', () => {
  it.each([
    ['Built APIs with Node.js for the billing team', 'Developed billing APIs using Node.js'],
    ['Built the dashboard in Next.js', 'Developed the dashboard using Next.js'],
    ['Built the dashboard in Vue.js', 'Developed the dashboard using Vue.js'],
    ['Built APIs with Express.js', 'Developed APIs using Express.js'],
    ['Built APIs with NodeJS', 'Developed APIs using Node.js'],
    ['Built APIs with Node', 'Developed APIs using Node.js'],
    ['Built the dashboard in React.js', 'Developed the dashboard using React'],
  ])('%s  ->  %s', (src, out) => { expect(mk(src, out)).toEqual([]) })
  it('a dotted tool the resume never mentions is still caught', () => {
    expect(mk('Built the dashboard in React', 'Developed the dashboard using Next.js').join(' ')).toMatch(/Nextjs/)
  })
})

describe('B2 - a tool name is matched as itself, not on a 5-letter stem', () => {
  it.each([
    ['Provided excellent reporting to managers each week', 'Built Excel reporting for managers each week', /Excel/],
    ['Excelled at weekly reporting to managers', 'Produced Excel reporting for managers weekly', /Excel/],
    ['Sparked adoption of weekly reporting among managers', 'Ran Spark jobs for weekly reporting among managers', /Spark/],
    ['Expressed requirements clearly to report owners', 'Built Express services for report owners', /Express/],
  ])('an invented tool is caught although the resume has a look-alike word (%s)', (src, out, re) => {
    expect(mk(src, out).join(' ')).toMatch(re)
  })
  it('an ordinary word is not an invented tool', () => {
    expect(mk('Provided weekly reporting to managers', 'Provided excellent weekly reporting to managers')).toEqual([])
  })
  it('a tool the resume really names (plural, alias or case) is still accepted', () => {
    expect(mk('Analysed data with Pandas and Postgres', 'Analyzed data using pandas and PostgreSQL')).toEqual([])
    expect(mk('Wrote scripts in JS', 'Wrote scripts in JavaScript')).toEqual([])
    expect(mk('Built dashboards in Excel', 'Built Excel dashboards')).toEqual([])
  })
  it('the stem still equates ordinary inflections for non-tool words', () => {
    expect(claimGuard.haveSet('managed engineering teams').has(claimGuard.foldWord('management'))).toBe(true)
  })
})

describe('B3 - the same rule in the skills list and the cover letter', () => {
  const src = fs.readFileSync('src/services/claude.service.js', 'utf8')
  it('unsupportedSkills and the letter check use the guard\'s own matching', () => {
    expect(src).toMatch(/const have = claimGuard\.haveSet\(sourceText\(orig\)\)/)
    expect(src).toMatch(/claimGuard\.knownWord\(have, w\)/)
    expect(src).toMatch(/\.filter\(w => claimGuard\.isTechTerm\(w\)\)/)
  })
})

describe('B4 - the AI re-check cannot run twice at once', () => {
  it('the write is conditional on the scan still being provisional, so a second click changes nothing and mails nothing', () => {
    expect(fs.readFileSync('src/controllers/scan.controller.js', 'utf8'))
      .toMatch(/\.eq\('fix_purchased', false\)\.eq\('status', scan\.status\)\.eq\('full_ats_report->>aiScored', 'false'\)\.select\('id'\)/)
  })
})
