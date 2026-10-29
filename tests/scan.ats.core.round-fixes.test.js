import { describe, it, expect } from 'vitest'
import { stem, scoreResume } from '../src/services/ats.service.js'
import { numbersIn, detectFabrication, inventedNumbers } from '../src/services/claude.service.js'

describe('-ization stems meet their verb forms', () => {
  for (const [a, b] of [['optimization', 'optimize'], ['organization', 'organizing'], ['standardization', 'standardize'], ['utilization', 'utilized'], ['customization', 'customize'], ['prioritization', 'prioritize']])
    it(`${a} ~ ${b}`, () => expect(stem(a)).toBe(stem(b)))
  it('a resume saying optimized/organized satisfies a JD asking for optimization/organization', () => {
    const jd = 'Software Engineer\nRequirements\nExperience with performance optimization and organization of large codebases. Strong optimization skills. Organization skills. Optimization of queries.\n'
    const resume = 'Jane Doe\njane@x.com\nEXPERIENCE\n- Optimized database queries and organized the codebase\nSKILLS\nPython\n'
    const missing = scoreResume(resume, jd).detail.keywords.missing
    expect(missing).not.toContain('optimization')
    expect(missing).not.toContain('organization')
  })
})

describe('numbersIn only treats proper thousands groups as one number', () => {
  it('splits bare digit lists', () => expect([...numbersIn('phases 1,2,3')].sort()).toEqual([1, 2, 3]))
  it('keeps thousands grouping', () => { expect(numbersIn('5,000 users').has(5000)).toBe(true); expect(numbersIn('$1,200,000').has(1200000)).toBe(true) })
  it('keeps decimals and suffixes', () => { expect(numbersIn('12.5%').has(12.5)).toBe(true); expect(numbersIn('2.5M users').has(2500000)).toBe(true) })
  it('does not flag a respaced list as invented', () => {
    const mk = b => ({ name: 'A B', experience: [{ company: 'Acme', title: 'Engineer', dates: '2020 - 2022', bullets: [b] }], education: [], skills: [] })
    expect(inventedNumbers(mk('Shipped phases 1,2,3 on schedule'), mk('Shipped phases 1, 2, 3 on schedule'))).toEqual([])
  })
})

describe('numbered grade promotions are fabrication', () => {
  const mk = t => ({ name: 'A B', experience: [{ company: 'Acme', title: t, dates: '2020 - 2022', bullets: ['Built x'] }], education: [], skills: [] })
  for (const [from, to] of [['Engineer', 'Engineer III'], ['Engineer I', 'Engineer II'], ['Engineer', 'Engineer 3'], ['Analyst', 'Analyst, Level 2']])
    it(`${from} -> ${to}`, () => expect(detectFabrication(mk(from), mk(to))).toBe(true))
  for (const [from, to] of [['Engineer II', 'Engineer II'], ['Engineer II', 'Engineer'], ['Software Engineer', 'Software Engineer']])
    it(`${from} -> ${to} is fine`, () => expect(detectFabrication(mk(from), mk(to))).toBe(false))
})
