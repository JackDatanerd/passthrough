import { describe, it, expect } from 'vitest'
const ats = require('../src/services/ats.service.js')

// Foreign function words that are also English words / tech terms (die, pour, NAS, DOS, COM, LOS...) were stop-listed
// unconditionally, so they vanished from every English posting and never counted for or against a resume.
describe('ambiguous foreign stop words in English postings', () => {
  it('keeps English/tech terms as keywords', () => {
    for (const w of ['die', 'pour', 'nas', 'dos', 'com', 'los']) {
      const jd = `Requirements: ${w} ${w} ${w}. Experience with ${w} required, plus ${w} and excel.`
      expect(Object.keys(ats.extractKeywords(jd)), w).toContain(w)
      expect([...ats.extractWeightedKeywords(jd).keys()], w).toContain(w)
    }
  })

  it('a die casting posting asks for "die casting"', () => {
    const kw = ats.extractKeywords('Die Casting Operator. Requirements: operate die casting machines, die maintenance, die setup.')
    expect(kw['die']).toBeGreaterThan(1)
    expect(kw['die casting']).toBeGreaterThan(0)
  })

  it('NAS in a posting changes the keyword score', () => {
    const jd = 'Systems Administrator. Requirements: Manage NAS storage, DOS scripting, Windows Server, Active Directory, backups. NAS NAS DOS DOS administration experience required.'
    const withIt = 'Jane Doe jane@x.com Systems Administrator. Managed NAS storage arrays, DOS batch scripting, Windows Server, Active Directory, backups.'
    const without = 'Jane Doe jane@x.com Systems Administrator. Managed storage arrays, batch scripting, Windows Server, Active Directory, backups.'
    expect(ats.scoreResume(withIt, jd).keywordScore).toBeGreaterThan(ats.scoreResume(without, jd).keywordScore)
  })

  it('still filters them as function words in a non-English posting', () => {
    const fr = `Nous recherchons un ingénieur pour rejoindre notre équipe. Vous serez responsable de la maintenance des machines pour les clients, avec les équipes de production dans une entreprise qui est en pleine croissance. Les missions sont variées pour tous les profils, et nous offrons un poste stable avec des avantages. Le poste est basé dans un site avec des horaires fixes pour toute l'équipe de production et de maintenance.`
    expect(Object.keys(ats.extractKeywords(fr))).not.toContain('pour')
    expect([...ats.extractWeightedKeywords(fr).keys()]).not.toContain('pour')
  })

  it('a short Spanish posting still filters con / para / los / más, and a stray one in English does not flip an English posting', () => {
    const es = [...ats.extractWeightedKeywords('Buscamos ingeniero. Será parte de nuestro equipo y también más allá, con los clientes y para ellos. Python.').keys()]
    for (const w of ['con', 'para', 'los', 'más', 'será']) expect(es).not.toContain(w)
    const en = [...ats.extractWeightedKeywords('Requirements: die casting experience. Our Los Angeles plant is hiring. Python and para-professional support.').keys()]
    expect(en).toContain('die')
    expect(en).toContain('los')
  })
})
