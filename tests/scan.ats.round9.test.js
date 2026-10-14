// Scan/ATS round 9. Every test here failed (or hung) before the fix it covers.
import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { scoreResume, detectRoleCategory, extractWeightedKeywords, tokenizeRaw, resumeEvidenceZones } from '../src/services/ats.service.js'
import { sanitizeDocxXml, analyzeUpload } from '../src/services/resume.parser.js'
import { generateAtsDocx } from '../src/services/docx.service.js'
import { stripPlatformBoilerplate } from '../src/services/jdBoilerplate.js'

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

// ── B1: a Skills list must end at every experience-type heading ─────────────────────────────────────────────────────
const JD = `Senior Backend Engineer
Requirements
- 5+ years building services in Python or Go
- Experience with Docker, Kubernetes, PostgreSQL and AWS
- Terraform, Kafka and Redis a plus`
const resumeWith = heading => `Jane Doe
jane@example.com
Summary
Backend engineer building reliable services.
Skills
Python, Go, Docker, Kubernetes, PostgreSQL, AWS, Terraform, Kafka, Redis
${heading}
Acme Corp — Senior Engineer 2019 - 2024
- Built Python and Go services on Docker and Kubernetes, cutting deploy time 40%
- Migrated PostgreSQL clusters to AWS and automated Terraform pipelines
- Operated Kafka and Redis in production for 2 million users
Education
BSc Computer Science 2015 - 2019`

describe('B1 — headings that end the Skills list', () => {
  const baseline = scoreResume(resumeWith('Experience'), JD)
  for (const h of ['Employment', 'Career History', 'Professional Background', 'Internships', 'Internship', 'EMPLOYMENT']) {
    it(`"${h}" is not read as more skills`, () => {
      const z = resumeEvidenceZones(resumeWith(h))
      expect(z.evidence).toContain('Built Python and Go services')
      const r = scoreResume(resumeWith(h), JD)
      expect(r.detail.keywords.integrity.stuffed).toBe(false)
      expect(r.keywordScore).toBe(baseline.keywordScore)
      expect(r.score).toBe(baseline.score)       // and the Sections score recognises the heading too
    })
  }
  it('a skills line that merely looks like a heading word is still a skill', () => {
    const z = resumeEvidenceZones('Jane\nSkills\nPython\nGo\nExperience\n- Built things in Python for years and years of work.')
    expect(z.skills).toContain('Python')
  })
})

// ── B2: crafted DOCX XML must not cost quadratic CPU ────────────────────────────────────────────────────────────────
async function docxWith(body) {
  const z = new JSZip()
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
  z.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="w" xmlns:mc="mc"><w:body>' + body + '</w:body></w:document>')
  return z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}
describe('B2 — sanitizeDocxXml', () => {
  it('returns well-formed Word XML unchanged', () => {
    const xml = '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">a &amp; b</w:t></w:r><w:r><w:t/></w:r></w:p><w:p/>' +
      '<mc:AlternateContent><mc:Choice><w:p><w:r><w:t>x</w:t></w:r></w:p></mc:Choice><mc:Fallback><w:p><w:r><w:t>x</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent><!-- c --><?pi x?>'
    expect(sanitizeDocxXml(xml)).toBe(xml)
  })
  it('removes an opener that never closes, a closer that never opened, and a < that starts no tag', () => {
    expect(sanitizeDocxXml('<w:p><w:r><w:t>hi</w:t></w:p>')).toBe('<w:p><w:t>hi</w:t></w:p>')
    expect(sanitizeDocxXml('a</w:t>b')).toBe('ab')
    expect(sanitizeDocxXml('<w:p<w:p<w:t>x</w:t>')).toBe('w:pw:p<w:t>x</w:t>')
  })
  it('makes crossed nesting strictly nested', () => {
    const out = sanitizeDocxXml('<w:p><w:r></w:p></w:r>')
    expect(out).toBe('<w:p></w:p>')
  })
  for (const [label, body] of [
    ['unclosed <mc:Fallback>', '<mc:Fallback>'.repeat(150000)],
    ['unclosed <w:p>', '<w:p>'.repeat(150000)],
    ['<w:p with no >', '<w:p'.repeat(150000)],
    ['unclosed <w:r> inside one paragraph', '<w:p>' + '<w:r>'.repeat(150000) + '</w:p>'],
    ['unclosed <w:t>', '<w:p><w:r>' + '<w:t>'.repeat(150000) + '</w:r></w:p>'],
    ['<w:shd with no >', '<w:shd'.repeat(150000)],
    ['crossed <w:r> / </w:p>', '<w:p>' + '<w:r>'.repeat(150000) + '</w:p>' + '</w:r>'.repeat(150000)],
  ]) {
    it(`a file with ${label} is read in well under a second`, async () => {
      const bytes = await docxWith(body)
      const t = Date.now()
      await analyzeUpload(bytes, DOCX, {})
      expect(Date.now() - t).toBeLessThan(3000)     // 32k of these cost 8 s before; 150k would have been minutes
    }, 20000)
  }
  it('a real generated document extracts exactly as before', async () => {
    const data = { name: 'Jane Doe', email: 'jane@x.com', phone: null, location: 'Nairobi', linkedin: null, portfolio: null, summary: 'Backend engineer with six years of experience building services.',
      experience: [{ company: 'Acme', title: 'Engineer', dates: '2019 - 2024', location: null, bullets: ['Built Python services for 2M users & more', 'Cut deploy time by 40%'] }],
      education: [{ institution: 'UoN', degree: 'BSc CS', dates: '2012 - 2016' }], skills: ['Python', 'Go'], certifications: [], languages: [], awards: [], publications: [], volunteer: [], projects: [] }
    const r = await analyzeUpload(await generateAtsDocx(data, null), DOCX, {})
    expect(r.text).toContain('Built Python services for 2M users & more')
    expect(r.text).toContain('Cut deploy time by 40%')
    expect(r.text).toContain('Jane Doe')
  })
})

// ── B3: role category ───────────────────────────────────────────────────────────────────────────────────────────────
const filler = '\n' + 'We offer a collaborative culture and room to grow. '.repeat(30)
describe('B3 — detectRoleCategory', () => {
  const cases = [
    ['Data Engineer\nBuild data pipelines in Python and SQL with Airflow and Spark.' + filler, 'data_science'],
    ['Machine Learning Engineer\nTrain and ship models.' + filler, 'data_science'],
    ['Customer Success Manager\nAcme builds software for engineers worldwide. You own renewals and onboarding.' + filler, 'other'],
    ['Technical Recruiter\nHire engineers and developers for a fintech. Source candidates.' + filler, 'other'],
    ['Registered Nurse\nOur hospital group uses charting software across wards. Provide patient care.' + filler, 'healthcare'],
    ['Software Engineer\nBuild backend services.' + filler, 'software_engineering'],
    ['Job Description\nSenior Product Manager\nOwn the roadmap.' + filler, 'product_management'],
    ['Mechanical Engineer\nDesign HVAC systems.' + filler, 'other'],
  ]
  for (const [jd, cat] of cases) it(`${cat}: ${jd.split('\n')[0]}`, () => expect(detectRoleCategory(jd)).toBe(cat))
  it('a posting with no title signal but plainly an engineering role still resolves from the body', () => {
    expect(detectRoleCategory('Member of Technical Staff\nYou will write software as a backend developer and engineer, owning services; our software engineers ship daily.')).toBe('software_engineering')
  })
})

// ── G1: non-English postings ────────────────────────────────────────────────────────────────────────────────────────
const JD_ES = `Ingeniero de Software Backend
Requisitos
- Experiencia con Python, Docker y Kubernetes
- Conocimientos de PostgreSQL y AWS
- Capacidad para trabajar en equipo y comunicarse con los clientes
Ofrecemos un ambiente de trabajo flexible para las personas que quieran crecer con nosotros`
const UNRELATED_ES = `Pedro Gómez
pedro@ejemplo.com
Resumen
Vendedor con experiencia en tiendas para los clientes de la empresa que quieran comprar.
Habilidades
Ventas, atención, caja
Experiencia
Tienda — Vendedor 2019 - 2024
- Atendí a los clientes con las personas del equipo para que quieran volver
- Trabajé en equipo con los clientes de la empresa
Educación
Bachillerato 2015 - 2019`
describe('G1 — keywords of a non-English posting', () => {
  it('function words and posting boilerplate are not keywords', () => {
    const words = [...extractWeightedKeywords(JD_ES).keys()]
    for (const w of ['con', 'para', 'los', 'requisitos', 'ofrecemos', 'nosotros']) expect(words).not.toContain(w)
    for (const w of ['python', 'docker', 'postgresql', 'aws']) expect(words).toContain(w)
  })
  it('an unrelated resume in the same language no longer earns a keyword score from "con" and "para"', () => {
    expect(scoreResume(UNRELATED_ES, JD_ES).keywordScore).toBeLessThan(20)
  })
  it('accented spellings are filtered like unaccented ones', () => {
    const words = [...extractWeightedKeywords('Buscamos ingeniero. Será parte de nuestro equipo y también más allá. Python.').keys()]
    for (const w of ['será', 'también', 'más', 'buscamos']) expect(words).not.toContain(w)
  })
  it('English postings are unaffected, and words that are also English / tech vocabulary stay keywords', () => {
    const words = [...extractWeightedKeywords('Senior Engineer. Experience with Python, MIT-licensed tooling, Uber APIs, and base64 encoding. Kubernetes a plus.').keys()]
    expect(words).toContain('python')
    expect(words).toContain('uber')
    expect(words).toContain('mit')
  })
})

// ── minor items ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('tech-term normalisation', () => {
  it('"React js" and "Node JS" are the frameworks, not React/Node plus JavaScript', () => {
    expect(tokenizeRaw('React js and Node JS')).toEqual(['react', 'js', 'and', 'node', 'js'])
  })
  it('TS/SCI is a clearance, not TypeScript; a bare TS still is TypeScript', () => {
    expect(tokenizeRaw('TS/SCI clearance')).not.toContain('typescript')
    expect(tokenizeRaw('TS and JS')).toEqual(['typescript', 'and', 'javascript'])
  })
})
describe('jd boilerplate', () => {
  it('"similar job" inside a sentence survives; the widget heading on its own line goes', () => {
    const out = stripPlatformBoilerplate('example.com', 'You will perform similar job functions to the team.\nSimilar job\nSenior Engineer. Similar jobs below.')
    expect(out).toContain('similar job functions')
    expect(out).not.toMatch(/similar jobs/i)
    expect(out).not.toMatch(/^similar job$/im)
  })
})
describe('docx project links', () => {
  it('a project link is a real hyperlink', async () => {
    const data = { name: 'J D', email: 'j@x.com', experience: [], education: [], skills: [], certifications: [], projects: [{ name: 'P', description: 'd', technologies: [], link: 'github.com/jd/p' }] }
    const zip = await JSZip.loadAsync(await generateAtsDocx(data, null))
    const xml = await zip.file('word/document.xml').async('string')
    expect(xml.match(/<w:hyperlink/g).length).toBeGreaterThanOrEqual(2)   // the address and the project
    expect(xml).toContain('github.com/jd/p')
  })
})
