import { describe, it, expect } from 'vitest'
import { buildResumeDiff } from '../src/lib/resumeDiff.js'

// Scan/ATS round 8: two entries at the same employer / school are paired by identity (dates, title, bullets),
// not by "first with the same name".
const base = { contact: {}, summary: '', skills: [], certifications: [] }
const dev  = { company: 'Acme', title: 'Dev',  dates: '2020-2022', bullets: ['Built API'] }
const lead = { company: 'Acme', title: 'Lead', dates: '2022-2024', bullets: ['Led team'] }
const view = d => d.experience.map(j => [j.jobStatus, j.beforeTitle, j.afterTitle, j.bullets.map(b => b.status).join(',')])

describe('same-company roles', () => {
  it('a dropped first role is reported as removed, and the kept role as unchanged', () => {
    const d = buildResumeDiff({ ...base, experience: [dev, lead] }, { ...base, experience: [lead] })
    expect(view(d)).toEqual([['removed', 'Dev', 'Dev', 'removed'], ['matched', 'Lead', 'Lead', 'unchanged']])
  })
  it('a reordered rewrite pairs each role with itself', () => {
    const d = buildResumeDiff({ ...base, experience: [dev, lead] }, { ...base, experience: [lead, dev] })
    expect(view(d)).toEqual([['matched', 'Dev', 'Dev', 'unchanged'], ['matched', 'Lead', 'Lead', 'unchanged']])
  })
  it('an edited role still pairs with its original when the other role is untouched', () => {
    const edited = { ...lead, bullets: ['Led a team of 5'] }
    const d = buildResumeDiff({ ...base, experience: [dev, lead] }, { ...base, experience: [dev, edited] })
    expect(d.experience.map(j => j.jobStatus)).toEqual(['matched', 'matched'])
    expect(d.experience[1].beforeTitle).toBe('Lead')
    expect(d.experience[1].titleChanged).toBe(false)
  })
  it('two degrees at one school pair by degree, not by position', () => {
    const bsc = { institution: 'State U', degree: 'BSc', dates: '2014-2018' }
    const msc = { institution: 'State U', degree: 'MSc', dates: '2018-2020' }
    const d = buildResumeDiff({ ...base, education: [bsc, msc] }, { ...base, education: [msc] })
    expect(d.education.map(e => [e.entryStatus, e.beforeTitle, e.titleChanged])).toEqual([['removed', 'BSc', false], ['matched', 'MSc', false]])
  })
  it('identical lists produce no changes', () => {
    const d = buildResumeDiff({ ...base, experience: [dev, lead] }, { ...base, experience: [dev, lead] })
    expect(d.experience.every(j => j.jobStatus === 'matched' && !j.titleChanged && j.bullets.every(b => b.status === 'unchanged'))).toBe(true)
  })
})
