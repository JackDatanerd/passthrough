import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
const ats = require('../src/services/ats.service')
const rp = require('../src/services/resume.parser')
const { stripPlatformBoilerplate } = require('../src/services/jdBoilerplate')

const mk = lines => 'Jane\njane@x.com\nEXPERIENCE\nEngineer — Foo 2020 – Present\n' + lines.map(l => '• ' + l).join('\n')

describe('round 20 — looksEnglish', () => {
  it('terse English bullets are English', () => {
    const t = 'Software Engineer — Foo Inc 2020 – Present\n' + Array.from({ length: 12 }, (_, i) =>
      `• Built payment APIs in Node.js, handling ${i + 2}M requests daily\n• Deployed services on AWS ECS, cut deploy time 60%`).join('\n')
    expect(ats.looksEnglish(t)).toBe(true)
  })
  it('Spanish is still not English', () => {
    const es = 'Responsable de ventas para la región con los clientes y las empresas que buscan soluciones para su equipo. Gestión de proyectos con el equipo de desarrollo y los clientes para mejorar los resultados de la empresa en el mercado. '.repeat(2)
    expect(ats.looksEnglish(es)).toBe(false)
  })
})

describe('round 20 — framework keywords count once', () => {
  const jd = 'Full Stack Developer\nRequirements: 3+ years of experience with Node.js, React.js, Next.js, TypeScript.'
  it('no bare node/react/next beside Node.js/React.js/Next.js', () => {
    const r = ats.scoreResume('Jane\njane@x.com\nEXPERIENCE\nDev — Foo 2020 – Present\n• Built Django apps with TypeScript for 30 clients', jd)
    const all = [...r.detail.keywords.missing, ...r.detail.keywords.matched]
    for (const w of ['node', 'react', 'next']) expect(all).not.toContain(w)
    expect(r.detail.keywords.missing).toEqual(expect.arrayContaining(['Node.js', 'React.js', 'Next.js']))
  })
  it('a resume saying plain "React" matches React.js', () => {
    const r = ats.scoreResume('Jane\njane@x.com\nEXPERIENCE\nDev — Foo 2020 – Present\n• Built React dashboards for 30 clients\nSKILLS\nReact', jd)
    expect(r.detail.keywords.matched).toContain('React.js')
  })
})

describe('round 20 — quantified figures', () => {
  it('time saved is a figure', () => {
    expect(ats.countQuantifiedFigures(mk(['Saved 15 hours per week']))).toBe(1)
    expect(ats.countQuantifiedFigures(mk(['Cut onboarding from 3 weeks to 5 days']))).toBe(2)
  })
  it('durations of experience are still not figures', () => {
    expect(ats.countQuantifiedFigures(mk(['Worked for 5 years on payments']))).toBe(0)
  })
  it('24/7 and 5G are not figures', () => {
    expect(ats.countQuantifiedFigures(mk(['Managed 24/7 on-call support']))).toBe(0)
    expect(ats.countQuantifiedFigures(mk(['Built 5G network monitoring tools']))).toBe(0)
  })
})

describe('round 20 — Skills heading synonyms', () => {
  const body = h => `Jane Doe\njane@x.com | +1 555 111 2222\nSUMMARY\nEngineer.\nEXPERIENCE\nEngineer — Foo 2020 – Present\n• Built APIs in Node.js, handling 2M requests daily\nEDUCATION\nBSc — State University 2014 – 2018\n${h}\nNode.js, React, AWS, Docker`
  for (const h of ['TECHNOLOGIES', 'TOOLS', 'TECH STACK', 'TECHNICAL PROFICIENCIES', 'Technologies & Tools'])
    it(`${h} counts as a skills section`, () => expect(ats.scoreResume(body(h), 'Engineer Node.js').detail.sections.missing).not.toContain('Skills'))
})

describe('round 20 — text boxes in DOCX', () => {
  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"'
  const p = t => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`
  const box = `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:wsp><wps:txbx><w:txbxContent>${p('Email: jane@x.com')}${p('Phone: 555 111 2222')}</w:txbxContent></wps:txbx></wps:wsp></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent>${p('Email: jane@x.com')}</w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r>`
  async function extract(body) {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>')
    zip.file('word/document.xml', `<?xml version="1.0"?><w:document ${NS}><w:body>${body}</w:body></w:document>`)
    return (await rp.extractDocxParts(await zip.generateAsync({ type: 'uint8array' }))).text
  }
  it('keeps the name that follows the anchor in the same paragraph', async () => {
    const t = await extract(`<w:p>${box}<w:r><w:t>Jane Doe</w:t></w:r></w:p>` + p('EXPERIENCE'))
    expect(t.split('\n')).toEqual(['Email: jane@x.com', 'Phone: 555 111 2222', 'Jane Doe', 'EXPERIENCE'])
  })
  it('does not fuse text before the box with the box text', async () => {
    const t = await extract(`<w:p><w:r><w:t>Jane Doe</w:t></w:r>${box}</w:p>` + p('EXPERIENCE'))
    expect(t.split('\n')).toEqual(['Jane Doe', 'Email: jane@x.com', 'Phone: 555 111 2222', 'EXPERIENCE'])
  })
})

describe('round 20 — Greenhouse/Lever anchor truncation', () => {
  const intro = 'Acme Analytics is a fast-growing company helping retailers understand their customers across more than forty countries with a team that values curiosity. '
  it('an EEO sentence in the intro does not drop the requirements', () => {
    const jd = `Data Analyst\n${intro}We are an equal opportunity employer and we celebrate diversity.\nRequirements\n- 3+ years of SQL\nBenefits\nHealth insurance`
    for (const host of ['boards.greenhouse.io', 'jobs.lever.co']) expect(stripPlatformBoilerplate(host, jd)).toContain('3+ years of SQL')
  })
  it('a closing EEO block is still cut', () => {
    const jd = `Data Analyst\nRequirements: SQL, Python, dbt, Tableau ${'and more detail '.repeat(20)}\nEqual Employment Opportunity\nAcme is an EEO employer.`
    expect(stripPlatformBoilerplate('boards.greenhouse.io', jd)).not.toContain('Acme is an EEO employer')
  })
})
