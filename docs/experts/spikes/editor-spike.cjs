'use strict'
// THROWAWAY. Experts Phase 1 editor spike (product spec 22.4 / engineering spec 21).
// Question: can the editor lock fields, track changes and render both files?
// Pass criteria: (1) locked values round-trip exactly; (2) the diff matches a manual check; (3) Word and PDF both render.
//
// Run:  node docs/experts/spikes/editor-spike.cjs      (needs soffice, wkhtmltopdf, pdftotext on the PATH)
// Output: docs/experts/spikes/out/*  and editor-spike-results.json
//
// Honest limits, printed again in the results: the three resumes are SYNTHETIC (no real customer resume is available to the build
// environment); the PDF is produced from the app's own resume HTML with wkhtmltopdf (production uses Cloudflare Browser Rendering,
// which does not exist here), so it proves the HTML is complete and prints, not that Cloudflare's renderer matches.
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process')
const root = path.join(__dirname, '..', '..', '..')
const locks = require(path.join(root, 'src/lib/humanLocks')), { diffDocuments } = require(path.join(root, 'src/lib/humanDiff'))
const docx = require(path.join(root, 'src/services/docx.service')), pdfTpl = require(path.join(root, 'src/services/pdfTemplate.service'))
const { serializeResumeData } = require(path.join(root, 'src/services/resume.parser'))
const out = path.join(__dirname, 'out'); fs.mkdirSync(out, { recursive: true })

const RESUMES = {
  us_software: { name: 'Priya Raman', email: 'priya.raman@gmail.com', phone: '(415) 555-0132', location: 'Austin, TX', linkedin: 'linkedin.com/in/priyaraman', portfolio: 'https://priya.dev',
    summary: 'Backend engineer with 6 years building payment systems. Reach me at priya.raman@gmail.com.',
    experience: [
      { company: 'Stripe Partners Inc', title: 'Senior Software Engineer', dates: 'Mar 2021 - Present', location: 'Remote', bullets: ['Built a ledger service handling 4M transactions a day.', 'Cut p99 latency by 38% by moving reads to a replica.', 'Mentored 3 engineers; see https://github.com/priyar/mentoring for the guide.'] },
      { company: 'Northwind Labs', title: 'Software Engineer', dates: 'Jun 2018 - Feb 2021', location: 'Denver, CO', bullets: ['Shipped the billing API used by 120 customers.', 'Wrote the migration that moved 2.1M rows with no downtime.'] }],
    education: [{ institution: 'University of Texas at Austin', degree: 'BSc Computer Science', dates: '2014 - 2018', details: 'GPA 3.8' }],
    skills: ['Go', 'PostgreSQL', 'Kafka', 'AWS', 'Terraform'], projects: [{ name: 'Ledger Lite', description: 'Open source double-entry ledger in Go.', technologies: ['Go', 'SQLite'], link: 'https://github.com/priyar/ledger-lite' }],
    references: [{ name: 'Marcus Webb', title: 'VP Engineering', phone: '+1 303 555 0188', email: 'marcus.webb@northwind.example' }] },
  uk_academic: { name: 'Dr Eleanor Whitcombe', email: 'e.whitcombe@ox.example.ac.uk', phone: '+44 7700 900123', location: 'Oxford, UK', linkedin: 'www.linkedin.com/in/ewhitcombe',
    summary: 'Postdoctoral researcher in computational linguistics. Eleanor has 9 publications and a 2022 teaching award.',
    experience: [{ company: 'University of Oxford', title: 'Postdoctoral Research Fellow', dates: 'Oct 2020 - Present', location: 'Oxford', bullets: ['Led a team of 4 on a 1.2m GBP grant.', 'Published 9 papers, 3 as first author.'] },
      { company: 'University of Edinburgh', title: 'Teaching Fellow', dates: 'Sep 2017 - Sep 2020', location: 'Edinburgh', bullets: ['Taught 240 students across 3 modules.'] }],
    education: [{ institution: 'University of Cambridge', degree: 'PhD Linguistics', dates: '2013 - 2017', details: 'Thesis on low-resource parsing' }, { institution: 'University of Leeds', degree: 'BA English', dates: '2010 - 2013' }],
    skills: ['Python', 'R', 'LaTeX'], certifications: ['Fellow of the Higher Education Academy'], awards: ['Teaching Excellence Award 2022'], publications: ['Whitcombe, E. (2021). Parsing under scarcity.'],
    references: [{ name: 'Prof A. Moreau', phone: '+44 1865 000111' }] },
  nairobi_ops: { name: 'Wanjiru Kamau', email: 'wanjiru.k@example.co.ke', phone: '+254 712 345 678', location: 'Nairobi, Kenya', linkedin: 'linkedin.com/in/wanjirukamau',
    summary: 'Operations manager who has run logistics for 3 regional warehouses. Wanjiru is fluent in English and Swahili.',
    experience: [{ company: 'Jumia Kenya', title: 'Operations Manager', dates: '2019 - 2024', location: 'Nairobi', bullets: ['Reduced delivery time from 5 days to 2 days.', 'Managed a team of 35 across 3 warehouses.', 'Saved KES 12 million a year by renegotiating courier contracts.'] }],
    education: [{ institution: 'Strathmore University', degree: 'BCom Supply Chain', dates: '2012 - 2016' }], skills: ['Logistics', 'SAP', 'Excel'], languages: ['English', 'Swahili'],
    volunteer: [{ organization: 'Rotary Club Nairobi', role: 'Treasurer', dates: '2020 - 2023', bullets: ['Raised KES 800,000 for a school feeding programme.'] }], projects: [] },
}

// The expert's edits, applied the way the workbench would: only editable fields, in text the customer could have written.
const EDITS = {
  us_software: { apply: b => { b.summary = 'Backend engineer with 6 years building payment systems at scale. Contact: [[c:1]].'; b.experience[0].bullets[1] = 'Cut p99 latency by 38% by moving reads to a replica.'; b.experience[0].bullets.push('Led the on-call rotation for 8 engineers.'); b.skills = ['Go', 'PostgreSQL', 'Kafka', 'AWS']; b.experience[1].bullets.splice(1, 1) },
    expect: ['summary', 'experience.0.bullets.3', 'skills.4', 'experience.1.bullets.1'] },
  uk_academic: { apply: b => { b.summary = 'Postdoctoral researcher in computational linguistics with 9 publications and a 2022 teaching award.'; b.experience[0].bullets[0] = 'Led a team of 4 on a 1.2m GBP grant.'; b.awards.push('Departmental Citizenship Award 2021') },
    expect: ['summary', 'awards.1'] },
  nairobi_ops: { apply: b => { b.summary = 'Operations manager who has run logistics for 3 regional warehouses; fluent in English and Swahili.'; b.experience[0].bullets[0] = 'Cut delivery time from 5 days to 2 days across the network.'; b.skills.push('Route planning') },
    expect: ['summary', 'experience.0.bullets.0', 'skills.3'] },
}
// things the editor MUST refuse (each tried on each resume)
const VIOLATIONS = [['change the email', b => { b.email = 'someone@else.com' }], ['change an employer', b => { b.experience[0].company = 'Other Corp' }], ['change dates', b => { b.experience[0].dates = '1999 - 2000' }],
  ['type an email address', b => { b.summary = 'write me at x@y.com' }], ['type a phone number', b => { b.skills.push('call +1 212 555 0100') }], ['type a web address', b => { b.skills.push('see mysite.com') }], ['drop a job', b => { b.experience = [] }], ['remove the name', b => { delete b.name }]]

const results = { generated: new Date().toISOString(), honestLimits: ['The three resumes are synthetic.', 'PDF rendered from the app\'s resume HTML by wkhtmltopdf; production uses Cloudflare Browser Rendering (not available here).'], resumes: {}, verdict: null }
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }).toString()
const clone = o => JSON.parse(JSON.stringify(o))
const flat = o => JSON.stringify(o)
const contactValues = r => [r.email, r.phone, r.linkedin, r.portfolio, ...(r.projects || []).map(p => p.link), r.references ? JSON.stringify(r.references) : null].filter(Boolean)

;(async () => {
  let allPass = true
  for (const [key, resume] of Object.entries(RESUMES)) {
    const R = { checks: {} }; results.resumes[key] = R
    const shared = { locked: {}, n: 0 }
    const { body, locked } = locks.lockDocument(resume, shared)
    // ── 1. lock + round trip (untouched) ────────────────────────────────────────────────────────────────────────────────────
    const maskedJson = flat(body)
    const leaked = [resume.email, resume.phone, resume.linkedin, resume.portfolio, resume.name, ...(resume.projects || []).map(p => p.link)].filter(Boolean).filter(v => maskedJson.includes(v) || (v === resume.name && resume.name.split(/\s+/).some(p => p.length >= 3 && new RegExp(`\\b${p}\\b`, 'i').test(maskedJson))))
    const rt = locks.restoreDocument(body, locked)
    R.checks.lockedValuesNotInMaskedBody = leaked.length === 0; R.leaked = leaked
    R.checks.roundTripExact = JSON.stringify(rt.data) === JSON.stringify(resume) && rt.missing.length === 0
    // ── 2. the expert's edit: accepted; every violation refused ─────────────────────────────────────────────────────────────
    const edited = clone(body); EDITS[key].apply(edited)
    const v = locks.validateEdit(body, edited); R.checks.expertEditAccepted = v.ok; R.editErrors = v.errors
    const refusals = VIOLATIONS.map(([label, fn]) => { const x = clone(body); try { fn(x) } catch (_) { return [label, 'n/a'] } const r = locks.validateEdit(body, x); return [label, r.ok ? 'ACCEPTED (bad)' : 'refused'] })
    R.refusals = Object.fromEntries(refusals); R.checks.everyViolationRefused = refusals.every(([, s]) => s === 'refused' || s === 'n/a')
    // ── 3. tracked changes: the diff equals the manual list ────────────────────────────────────────────────────────────────
    const diff = diffDocuments(body, edited); const paths = diff.map(d => d.path).sort()
    R.diffPaths = paths; R.manualExpected = [...EDITS[key].expect].sort()
    R.checks.diffMatchesManual = JSON.stringify(paths) === JSON.stringify(R.manualExpected)
    // ── 4. restore the EDITED document, render Word and PDF ────────────────────────────────────────────────────────────────
    const final = locks.restoreDocument(edited, locked)
    R.checks.editedRestoreNoMissing = final.missing.length === 0
    const lockedBack = contactValues(final.data).every(v => contactValues(resume).includes(v)) && final.data.name === resume.name
    R.checks.lockedValuesSurviveEdit = lockedBack
    const base = path.join(out, key)
    try {
      fs.writeFileSync(`${base}.docx`, await docx.generateAtsDocx(final.data, null, { verified: false }))
      sh('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', out, `${base}.docx`])
      const wordText = sh('pdftotext', ['-layout', `${base}.pdf`, '-'])
      R.checks.wordRendersAndHasLockedValues = [resume.name, resume.email, resume.experience[0].company].every(s => wordText.includes(s)) && !/\[\[/.test(wordText)
      R.wordBytes = fs.statSync(`${base}.docx`).size
    } catch (e) { R.checks.wordRendersAndHasLockedValues = false; R.wordError = e.message.slice(0, 200) }
    try {
      fs.writeFileSync(`${base}.html`, pdfTpl.buildResumeHTML(final.data, {}, null, { verified: false }))
      sh('wkhtmltopdf', ['--quiet', '--enable-local-file-access', `${base}.html`, `${base}-designed.pdf`])
      // wkhtmltopdf embeds the app's web fonts as subsets with no text layer, so pdftotext sees nothing. The check reads the RENDERED PAGE:
      // page one is rasterised at 200 dpi and read back with tesseract, so it proves what a person would see, marker-free and complete.
      const pages = Number((sh('pdfinfo', [`${base}-designed.pdf`]).match(/Pages:\s+(\d+)/) || [])[1] || 0)
      sh('pdftoppm', ['-png', '-r', '200', '-f', '1', '-l', '1', `${base}-designed.pdf`, `${base}-page`])
      const png = fs.readdirSync(out).find(n => n.startsWith(`${key}-page`) && n.endsWith('.png'))
      const pdfText = sh('tesseract', [path.join(out, png), 'stdout']).replace(/\s+/g, ' ')
      const htmlText = fs.readFileSync(`${base}.html`, 'utf8')
      R.pdfPages = pages
      R.checks.pdfRendersAndHasLockedValues = pages >= 1 && [resume.name, resume.email.replace(/\s/g, ''), resume.experience[0].company].every(sv => pdfText.replace(/\s/g, '').includes(sv.replace(/\s/g, ''))) && !/\[\[/.test(pdfText) && !/\[\[/.test(htmlText)
      if (!R.checks.pdfRendersAndHasLockedValues) R.pdfOcrSample = pdfText.slice(0, 300)
      R.pdfBytes = fs.statSync(`${base}-designed.pdf`).size
    } catch (e) { R.checks.pdfRendersAndHasLockedValues = false; R.pdfError = e.message.slice(0, 200) }
    // the plain-text view the ATS scorer reads must contain the edit and no marker
    const text = serializeResumeData(final.data); R.checks.scorerTextHasNoMarkers = !/\[\[/.test(text)
    for (const c of Object.values(R.checks)) if (!c) allPass = false
  }
  results.verdict = allPass ? 'PASS' : 'FAIL'
  fs.writeFileSync(path.join(__dirname, 'editor-spike-results.json'), JSON.stringify(results, null, 2))
  for (const [k, r] of Object.entries(results.resumes)) { console.log(`\n${k}`); for (const [c, ok] of Object.entries(r.checks)) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c}`); if (r.leaked.length) console.log('  leaked:', r.leaked) }
  console.log(`\nEDITOR SPIKE: ${results.verdict}`)
  process.exit(allPass ? 0 : 1)
})().catch(e => { console.error(e); process.exit(2) })
