// Scan / ATS round 12 - one test group per fix. Each states the failure it used to produce.
import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'module'
import JSZip from 'jszip'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

const require = createRequire(import.meta.url)
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

// ── B1: text from outside is cleaned before it is scored, sent to the model or stored ─────────────────────────────────────
describe('B1 - NUL and lone surrogates from third-party text', () => {
  const { cleanText, cleanDeep, safeSlice } = require('../src/lib/safeText')
  const ats = require('../src/services/ats.service')
  const jd = require('../src/services/jd.parser')
  const parser = require('../src/services/resume.parser')

  async function docxWith(paras) {
    const z = new JSZip()
    z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>')
    const body = paras.map(t => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`).join('')
    z.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`)
    return new Uint8Array(await z.generateAsync({ type: 'uint8array' }))
  }
  const RESUME = ['Jane Doe', 'jane@example.com | 555 123 4567', 'SUMMARY', 'Operations specialist with a long record of running support teams and training programmes across regions.',
    'EXPERIENCE', 'Support Lead - Acme - 2019 - 2024',
    '• Managed the regional onboarding programme for new support staff &#xD83D; and reviewed every training module carefully before release',
    '• Led weekly planning sessions with managers across the business units and tracked actions closely',
    '• Built reporting dashboards for the leadership group and trained analysts to maintain them well',
    'EDUCATION', 'BSc Business - Some University - 2015', 'SKILLS', 'Support, Training, Reporting']

  it('cleanText removes NUL and lone halves, keeps real emoji; cleanDeep does it inside objects and keys', () => {
    expect(cleanText('a\u0000b\ud83dc')).toBe('abc')
    expect(cleanText('ok \ud83d\ude80')).toBe('ok \ud83d\ude80')
    expect(cleanText(5)).toBe(5)
    const deep = cleanDeep({ 'k\u0000': ['x\ud83d', { y: 'a\u0000' }], n: 1 })
    expect(JSON.stringify(deep)).toBe('{"k":["x",{"y":"a"}],"n":1}')
  })

  it('a docx numeric reference to NUL or half a surrogate no longer reaches the extracted text', async () => {
    for (const bad of ['&#xD83D;', '&#0;', '&#55357;']) {
      const bytes = await docxWith(RESUME.map(p => p.replace('&#xD83D;', bad)))
      const up = await parser.analyzeUpload(bytes, DOCX_MIME, {})
      expect(up.failure).toBe(null)
      expect(LONE.test(up.text)).toBe(false)
      expect(up.text.includes('\u0000')).toBe(false)
      expect(await parser.extractText(bytes, DOCX_MIME)).not.toMatch(/\u0000/)
    }
  })

  it('the stored report cannot hold half an emoji: an emoji across the 160-character cut is dropped, not split', () => {
    let lead = 'Managed the regional onboarding programme for new support staff across several offices and reviewed every training module carefully before release to the teams '
    while (lead.length < 159) lead += 'x'
    const bullet = lead.slice(0, 159) + '\ud83d\ude80 and more words afterwards to make the line long enough'
    const text = ['Jane Doe', 'jane@example.com | 555 123 4567', '', 'SUMMARY', 'Operations specialist with a long record of running support teams.', '',
      'EXPERIENCE', 'Support Lead - Acme - 2019 - 2024', '• ' + bullet,
      '• Led weekly planning sessions with managers across the business units and tracked actions',
      '• Built reporting dashboards for the leadership group and trained analysts to maintain them', '', 'EDUCATION', 'BSc Business - Some University - 2015', '', 'SKILLS', 'Support, Training'].join('\n')
    const r = ats.scoreResume(text, 'Support Lead. Managing teams, training, reporting and planning. '.repeat(3))
    expect(LONE.test(JSON.stringify(r.detail))).toBe(false)
    expect(JSON.stringify(r.detail)).not.toMatch(/\\ud83d(?!\\ude)/i)
    expect(safeSlice('ab\ud83d\ude80', 3)).toBe('ab')
  })

  it('a job posting fetched from a page: JSON-LD with half an emoji, and a raw NUL, come out clean', () => {
    const body = 'Senior Support Engineer. We are looking for someone to own customer escalations, write runbooks, and mentor the team. Requirements: 5 years of experience with Linux, SQL, and incident response. Our culture is friendly \ud83d'
    const ld = JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Senior Support Engineer', description: body })
    const t = jd.extractJobPostingText(`<html><head><script type="application/ld+json">${ld}</script></head><body>x</body></html>`)
    expect(t).toBeTruthy()
    expect(LONE.test(t)).toBe(false)
    const page = '<html><body><h1>Support Engineer</h1><p>Own escalations\u0000 and write runbooks. ' + 'Requirements: Linux, SQL, incident response. '.repeat(5) + '</p></body></html>'
    expect(jd.htmlToText(page).includes('\u0000')).toBe(false)
  })
})

// ── B2: the hourly sweep and a stuck Badge -> Fix upgrade ─────────────────────────────────────────────────────────────────
describe('B2 - a stuck upgrade is reverted, not delivered as a rewrite-less FIX', () => {
  const state = { db: null }
  const sbPath = require.resolve('../src/config/supabase.js')
  const realSupabase = require('../src/config/supabase.js')
  require.cache[sbPath].exports = { ...realSupabase, getSupabase: () => state.db }

  async function runSweep(resolver) {
    state.db = createFakeSupabase(q => (q.table === 'system_state' ? { data: { value: { version: 95 } }, error: null } : resolver(q)))
    const { default: worker } = await import('../src/index.js')
    const pending = []
    const env = { SUPABASE_URL: 'u', SUPABASE_SERVICE_ROLE_KEY: 'k', JWT_SECRET: 'j'.repeat(40), FRONTEND_URL: 'https://x.test' }
    worker.scheduled({ cron: '0 * * * *' }, env, { waitUntil: p => pending.push(p) })
    await Promise.allSettled(pending)
    return state.db
  }
  const isUpgradeLookup = q => q.table === 'scans' && q.op === 'select' && q.cols === 'id, user_id' && q.filters.some(f => f[0] === 'not' && f[1] === 'badge_upgraded_at')
  const revertUpdate = db => db.calls.find(q => q.table === 'scans' && q.op === 'update' && q.patch.fix_tier === 'BADGE')
  const credits = db => db.calls.filter(c => c.op === 'rpc' && c.name === 'increment_free_fix_credits')
  const redelivery = db => db.calls.find(q => q.table === 'scans' && q.op === 'update' && q.patch.status === 'FIX_DELIVERED' && q.patch.fix_tier === undefined)

  it('puts the scan back to BADGE / FIX_DELIVERED, clears the marker and returns the credit', async () => {
    const db = await runSweep(q => {
      if (isUpgradeLookup(q)) return { data: [{ id: 'up1', user_id: 'u1' }], error: null }
      if (q.table === 'scans' && q.op === 'select' && q.maybe) return { data: { upgrade_credit_granted_at: null }, error: null }
      if (revertUpdate({ calls: [q] })) return { data: [{ id: 'up1' }], error: null }
    })
    const r = revertUpdate(db)
    expect(r.patch).toMatchObject({ fix_tier: 'BADGE', status: 'FIX_DELIVERED', badge_upgraded_at: null, upgrade_credit_granted_at: null })
    expect(credits(db)).toHaveLength(1)
    expect(credits(db)[0].args).toEqual({ p_user_id: 'u1' })
  })

  it('the plain redelivery flip leaves upgrades alone', async () => {
    const db = await runSweep(() => undefined)
    const flip = redelivery(db)
    expect(flip).toBeTruthy()
    expect(flip.filters).toEqual(expect.arrayContaining([['is', 'badge_upgraded_at', null]]))
  })

  it('does not return the credit a second time when the run had already handed it back', async () => {
    const db = await runSweep(q => {
      if (isUpgradeLookup(q)) return { data: [{ id: 'up1', user_id: 'u1' }], error: null }
      if (q.table === 'scans' && q.op === 'select' && q.maybe) return { data: { upgrade_credit_granted_at: '2026-10-17T00:00:00Z' }, error: null }
      if (revertUpdate({ calls: [q] })) return { data: [{ id: 'up1' }], error: null }
    })
    expect(revertUpdate(db)).toBeTruthy()
    expect(credits(db)).toHaveLength(0)
  })

  it('a scan whose revert did not apply is kept out of the redelivery flip', async () => {
    const db = await runSweep(q => {
      if (isUpgradeLookup(q)) return { data: [{ id: 'up1', user_id: 'u1' }], error: null }
      if (q.table === 'scans' && q.op === 'select' && q.maybe) return { data: { upgrade_credit_granted_at: null }, error: null }
      if (revertUpdate({ calls: [q] })) return { data: [], error: null }
    })
    expect(credits(db)).toHaveLength(0)
    expect(redelivery(db).filters).toEqual(expect.arrayContaining([['not', 'id', 'in', '(up1)']]))
  })
})

// ── B3 + paper: the edit endpoint ─────────────────────────────────────────────────────────────────────────────────────────
let t
afterEach(() => t?.restore())

describe('B3 / paper - updateDeliveredResume', () => {
  function setup(scanOver = {}) {
    const state = { updates: [], docxOpts: [], tokenOpts: [] }
    const scan = {
      id: 's1', user_id: 'u1', status: 'FIX_DELIVERED', fix_purchased: true, fix_tier: 'FIX', fix_retry_count: 1, fix_retry_no_gain: true,
      job_description_text: 'We are a US company hiring in Austin, Texas. ' + 'x'.repeat(60), original_resume_data: { name: 'Jane' }, rewritten_resume_data: { name: 'Jane', skills: ['Old'] },
      resume_ats_path: 'old.docx', resume_pdf_path: 'old.pdf', resume_hash: 'oldhash', resume_pdf_hash: 'oldpdf',
      verification_code: 'CODE1', verification_url: 'https://passthrough.dev/v/CODE1', verified_at: '2026-01-01', quantification_prompts: [], ...scanOver,
    }
    const db = createFakeSupabase(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: scan, error: null }
      if (q.table === 'scans' && q.op === 'update') { state.updates.push(q); return { data: [{ id: 's1' }], error: null } }
    })
    const m = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/resume.parser.js': { extractText: async () => 'x'.repeat(200) },
      'services/docx.service.js': { generateAtsDocx: async (d, url, o) => { state.docxOpts.push(o); return Buffer.from('docx') } },
      'services/ats.service.js': { scoreResume: () => ({ score: 90, detail: {} }), describeWeakAreas: () => [] },
      'services/claude.service.js': { scoreResumeWithAI: async () => ({ success: true, data: JSON.stringify({ aiScore: 90, missingKeywords: [] }) }), extractJson: x => JSON.parse(x) },
      'services/badge.service.js': { hashBytes: async () => 'newhash' },
      'services/design.service.js': { getDesignTokens: (u, s, i, o) => { state.tokenOpts.push(o); return {} }, detectPaper: j => (/Texas/.test(j) ? 'letter' : 'a4') },
      'services/pdf.service.js': { generateResumePDF: async () => Buffer.from('pdf') },
      'lib/badgeCache.js': { purgeBadgeCache: async () => {} },
    })
    const env = { RESUMES_BUCKET: { put: async () => {}, delete: async () => {} } }
    return { ...m, state, env }
  }
  const ctx = (env, body) => ({
    env, get: k => (k === 'user' ? { id: 'u1', emailVerified: true } : undefined),
    req: { param: () => 's1', query: () => undefined, json: async () => body },
    json: (b, status = 200) => ({ body: b, status }), header: () => {}, body: b => ({ rawBody: b }),
  })
  const edit = { name: 'Jane', skills: ['New'], experience: [{ company: 'Acme', title: 'Eng', dates: '2020', bullets: ['Built APIs'] }] }

  it('B3: the "retry found nothing better" flag is cleared once the owner edits the resume', async () => {
    t = setup()
    const res = await t.mod.updateDeliveredResume(ctx(t.env, { resumeData: edit }))
    expect(res.status).toBe(200)
    expect(res.body.data.retryNoGain).toBe(false)
    expect(t.state.updates.some(q => q.patch.fix_retry_no_gain === false)).toBe(true)
  })

  it('B3: nothing is written when the flag was not set', async () => {
    t = setup({ fix_retry_no_gain: false })
    await t.mod.updateDeliveredResume(ctx(t.env, { resumeData: edit }))
    expect(t.state.updates.some(q => 'fix_retry_no_gain' in q.patch)).toBe(false)
  })

  it('paper: with no choice the posting decides, and the main write does not touch paper_size', async () => {
    t = setup()
    await t.mod.updateDeliveredResume(ctx(t.env, { resumeData: edit }))
    expect(t.state.docxOpts[0].paper).toBe('letter')
    expect(t.state.updates[0].patch).not.toHaveProperty('paper_size')
  })

  it('paper: the person\'s choice wins over the posting, is stored, and reaches the docx and the PDF design', async () => {
    t = setup()
    const res = await t.mod.updateDeliveredResume(ctx(t.env, { resumeData: edit, paper: 'a4' }))
    expect(res.status).toBe(200)
    expect(res.body.data.paperSize).toBe('a4')
    expect(t.state.docxOpts.every(o => o.paper === 'a4')).toBe(true)
    expect(t.state.updates[0].patch.paper_size).toBe('a4')
    expect(t.state.tokenOpts.some(o => o?.paper === 'a4')).toBe(true)
  })

  it('paper: a stored choice is kept on later edits, "auto" clears it, junk is a 400', async () => {
    t = setup({ paper_size: 'a4' })
    await t.mod.updateDeliveredResume(ctx(t.env, { resumeData: edit }))
    expect(t.state.docxOpts[0].paper).toBe('a4')
    expect(t.state.updates[0].patch).not.toHaveProperty('paper_size')
    t.restore(); t = setup({ paper_size: 'a4' })
    await t.mod.updateDeliveredResume(ctx(t.env, { resumeData: edit, paper: 'auto' }))
    expect(t.state.updates[0].patch.paper_size).toBe(null)
    expect(t.state.docxOpts[0].paper).toBe('letter')
    t.restore(); t = setup()
    const bad = await t.mod.updateDeliveredResume(ctx(t.env, { resumeData: edit, paper: 'foolscap' }))
    expect(bad.status).toBe(400)
  })
})

// ── B4: spelled-out figures ───────────────────────────────────────────────────────────────────────────────────────────────
describe('B4 - number words', () => {
  const cs = require('../src/services/claude.service')
  const base = bullets => ({ name: 'A B', email: 'a@b.co', experience: [{ company: 'Acme', title: 'Developer', dates: '2019 - 2022', bullets }], skills: ['Python'] })
  const invented = (a, b) => [...cs.inventedNumbers(base(a), base(b))]
  it.each([
    ['25 -> twenty-five', 'Trained 25 new hires', 'Trained twenty-five new hires'],
    ['twenty-five -> 25', 'Trained twenty-five new hires', 'Trained 25 new hires'],
    ['21 -> twenty one', 'Served 21 clients', 'Served twenty one clients'],
    ['200 -> two hundred', 'Handled 200 tickets', 'Handled two hundred tickets'],
    ['2M -> two million', 'Reached 2M users', 'Reached two million users'],
    ['500k -> half a million', 'Reached 500k users', 'Reached half a million users'],
    ['3 -> three', 'Led a team of 3', 'Led a three-person team'],
  ])('an honest rewrite is not an invented figure: %s', (_l, a, b) => expect(invented(a, b)).toEqual([]))
  it('a genuinely new figure is still caught, including the tens that were not recognised before', () => {
    expect(invented(['Trained new hires'], ['Trained twenty-five new hires'])).toEqual([25])
    expect(invented(['Led a team'], ['Led a team of sixty engineers'])).toEqual([60])
    expect(invented(['Trained 25 hires'], ['Trained thirty hires'])).toEqual([30])
  })
  it('"one" on its own is ordinary English, not a figure', () => {
    expect(invented(['Led a team'], ['Led one of the largest teams'])).toEqual([])
  })
})

// ── B5: career length ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('B5 - years of experience are the time worked, not first-start to last-end', () => {
  const { careerFacts } = require('../src/lib/careerFacts')
  const now = new Date('2026-10-17T00:00:00Z')
  const years = jobs => careerFacts({ experience: jobs.map(dates => ({ dates })) }, now).years
  it('a gap counts for nothing', () => {
    expect(years(['2005 - 2007', '2020 - Present'])).toBe(8)
    expect(years(['2012 - 2014', '2023 - 2024'])).toBe(3)
  })
  it('overlapping and back-to-back jobs count once', () => {
    expect(years(['2018 - 2022', '2020 - 2023'])).toBe(5)
    expect(years(['2018 - 2021', '2021 - 2024'])).toBe(6)
    expect(years(['2016 - Present'])).toBe(10)
  })
  it('keeps the old first-to-last number as `span`, and null with no dates', () => {
    expect(careerFacts({ experience: [{ dates: '2005 - 2007' }, { dates: '2020 - Present' }] }, now).span).toBe(21)
    expect(careerFacts({ experience: [{ dates: null }] }, now).years).toBe(null)
  })
  it('so the guard no longer lets a summary claim the whole window', () => {
    const { tenureClaimOk } = require('../src/lib/careerFacts')
    const facts = careerFacts({ experience: [{ dates: '2005 - 2007' }, { dates: '2020 - Present' }] }, now)
    expect(tenureClaimOk(8, facts, new Set())).toBe(true)
    expect(tenureClaimOk(21, facts, new Set())).toBe(false)
  })
})

// ── B6: paper detection ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('B6 - detectPaper', () => {
  const { detectPaper, resolvePaper, cleanPaperChoice } = require('../src/services/design.service')
  it.each([
    ['Software Engineer, Birmingham, Alabama. Build APIs for our US customers.', 'letter'],
    ['Backend Developer based in London, Ontario. Hybrid. Competitive salary in CAD.', 'letter'],
    ['Nurse Manager at our Manchester, NH hospital. Full-time.', 'letter'],
    ['Chicago-based team supporting US and UK customers. Python, SQL.', 'letter'],
    ['Join our team in Austin, Texas. You will own the analytics roadmap.', 'letter'],
    ['Support Engineer, Dublin. Python.', 'a4'],
    ['Backend Engineer in Berlin, Germany. Python and Go.', 'a4'],
    ['Product Analyst, Nairobi. SQL and dashboards.', 'a4'],
    ['Operations Manager, Manchester, UK. 40k-50k GBP, £ per year.', 'a4'],
    ['We organise programmes with colour-coded centres.', 'a4'],
    ['', 'letter'],
  ])('%s -> %s', (jd, expected) => expect(detectPaper(jd)).toBe(expected))
  it('the person\'s choice wins; anything else falls back to the posting', () => {
    expect(resolvePaper('a4', 'Austin, Texas')).toBe('a4')
    expect(resolvePaper('LETTER', 'Berlin, Germany')).toBe('letter')
    expect(resolvePaper('auto', 'Berlin, Germany')).toBe('a4')
    expect(resolvePaper(null, 'Austin, Texas')).toBe('letter')
    expect(cleanPaperChoice(' A4 ')).toBe('a4')
    expect(cleanPaperChoice('foolscap')).toBe(null)
  })
})

// ── B7: the letter guard ──────────────────────────────────────────────────────────────────────────────────────────────────
describe('B7 - a letter may restate what the posting asks for', () => {
  const cs = require('../src/services/claude.service')
  const { careerFacts } = require('../src/lib/careerFacts')
  const resume = { name: 'Jo Bloggs', experience: [{ company: 'Acme', title: 'Analyst', dates: '2023 - 2025', bullets: ['Built weekly reports for the finance team'] }], skills: ['Excel'] }
  const facts = careerFacts(resume, new Date('2026-10-17'))
  const jd = 'Analyst role. We ask for five years of experience with Excel and reporting.'
  const run = body => {
    const letter = `Dear Hiring Manager,\n\n${body}\n\nSincerely,\nJo Bloggs`
    const have = cs.numbersIn('Built weekly reports for the finance team 2023 - 2025')
    return cs.checkLetter(letter, { resumeData: resume, jdText: jd, details: {}, allowedNumbers: new Set([...have, ...cs.numbersIn(jd)]), facts, haveNumbers: have, corpus: JSON.stringify(resume) + jd }).hard
  }
  it('restating the posting\'s requirement is fine', () => {
    expect(run('Your posting asks for five years of experience, and while my path is shorter, I have built weekly finance reports at Acme.')).toEqual([])
    expect(run('I know the five years of experience you ask for is a lot, so I would start with the reporting calendar.')).toEqual([])
  })
  it('claiming those years as the applicant\'s own still fails', () => {
    expect(run('With five years of experience building finance reports, I would hit the ground running.').join(' ')).toMatch(/figures that are not in the resume/)
    expect(run('As your posting asks, I bring five years of experience.').join(' ')).toMatch(/figures that are not in the resume/)
  })
})

// ── B8: first person ──────────────────────────────────────────────────────────────────────────────────────────────────────
describe('B8 - Roman numerals are not first person', () => {
  const ats = require('../src/services/ats.service')
  const fp = bullet => ats.scoreResume(`Dev\nd@x.com\nEXPERIENCE\nNurse - Clinic - 2020 - 2024\n• ${bullet}\n• Supported 40 clinic visits weekly with accurate records\nEDUCATION\nBSN - Univ - 2019\nSKILLS\nCare`, 'Nurse role with patient care.').detail.content.craft.firstPerson
  it.each([
    ['I led the clinic intake team and cut waits', 1],
    ['My team handled weekly visits for the clinic', 1],
    ['Helped me and others prepare reports for the clinic', 1],
    ['Monitored Phase I trials and recorded results carefully', 0],
    ['Cared for Type I diabetes patients and taught families daily', 0],
    ['Worked on Series I funding paperwork for the clinic team', 0],
  ])('%s -> %i', (bullet, n) => expect(fp(bullet)).toBe(n))
})

// ── B9: the extractor and a link whose text contains an ampersand ─────────────────────────────────────────────────────────
describe('B9 - a link that already shows its URL is not printed twice', () => {
  const docx = require('../src/services/docx.service')
  const parser = require('../src/services/resume.parser')
  it('an address with & in its query string appears once in the extracted contact line', async () => {
    const bytes = await docx.generateAtsDocx({ name: 'Hannah W', email: 'a@b.co', portfolio: 'https://amina.dev/?a=1&b=2', experience: [{ company: 'Acme', title: 'Eng', dates: '2020 - 2024', bullets: ['Built APIs'] }] }, null, {})
    const text = await parser.extractText(bytes, DOCX_MIME)
    expect(text.match(/amina\.dev\/\?a=1&b=2/g)).toHaveLength(1)
  })
})

// ── Paper-size feature: intake and storage ────────────────────────────────────────────────────────────────────────────────
describe('paper size - createScan intake', () => {
  it('a value that is not Auto / Letter / A4 is refused before anything is spent', async () => {
    const db = createFakeSupabase(() => undefined)
    t = loadWithStubs('controllers/scan.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    const ctx = {
      env: {}, get: k => (k === 'formFields' ? { paperSize: 'foolscap', jobDescriptionText: 'x'.repeat(80) } : k === 'user' ? { id: 'u1', emailVerified: true } : undefined),
      req: { param: () => undefined, query: () => undefined, header: () => undefined },
      json: (b, status = 200) => ({ body: b, status }),
    }
    const res = await t.mod.createScan(ctx)
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/Auto, US Letter or A4/)
    expect(db.calls.some(c => c.op === 'rpc' && c.name === 'increment_scan_count_if_under_limit')).toBe(false)
  })
})

describe('paper size - the client sees the choice', () => {
  it('scanRowToCamel maps paper_size to paperSize and the client allow-list carries it', () => {
    const { scanRowToCamel, toClientScan } = require('../src/lib/mappers')
    expect(scanRowToCamel({ id: 's1', paper_size: 'a4' }).paperSize).toBe('a4')
    expect(scanRowToCamel({ id: 's1' }).paperSize).toBe(null)
    if (toClientScan) expect(toClientScan(scanRowToCamel({ id: 's1', user_id: 'u1', paper_size: 'a4' }), { owner: true })).toHaveProperty('paperSize', 'a4')
  })
})

// ── B10: the checklist's evidence check ───────────────────────────────────────────────────────────────────────────────────
describe('B10 - a quote must carry substance and match whole words', () => {
  const { computeChecklistScore, quoteInResume, canon } = require('../src/lib/atsChecklist')
  const resumeText = 'Jane Doe\nEXPERIENCE\nAnalyst - Acme - 2020 - 2024\n• Wrote Python scripts for weekly reports for the finance team\nSKILLS\nPython, Excel'
  const jdText = 'We need Kubernetes, Terraform and Rust experience plus Python for data work and Excel reporting.'
  const row = (requirement, status, evidence) => ({ requirement, priority: 'must', status, evidence })
  const score = ev => computeChecklistScore({ requirements: [row('Kubernetes', 'met', ev), row('Terraform', 'met', ev), row('Rust experience', 'met', ev), row('Python', 'met', 'Wrote Python scripts for weekly reports')], seniority: 'match', title: 'strong' }, { resumeText, jdText })
  it.each(['a', 'e', 'ython', 'the', 'for the', 'a for the of'])('the quote %j does not prove a requirement the resume never mentions', ev => {
    const r = score(ev)
    expect(r.downgraded).toBe(3)
    expect(r.score).toBeLessThan(60)
  })
  it('a real quote, a one-word skill quote and a quote with different punctuation still count', () => {
    const c = canon(resumeText), set = new Set(c.split(' '))
    expect(quoteInResume('Wrote Python scripts for weekly reports', c, set)).toBe(true)
    expect(quoteInResume('Python', c, set)).toBe(true)
    expect(quoteInResume('wrote python scripts, for weekly reports!', c, set)).toBe(true)
  })
})

// ── B11: the rewrite style guard ──────────────────────────────────────────────────────────────────────────────────────────
describe('B11 - the style guard does not flag correct wording', () => {
  const { findRewriteStyleProblems } = require('../src/lib/rewriteStyle')
  const orig = { experience: [{ bullets: ['Ran pricing tests'] }] }
  const problems = b => findRewriteStyleProblems(orig, { experience: [{ company: 'Acme', bullets: [b] }] })
  it.each([
    'Monitored Phase I trials for 40 clinics across the region',
    'Built dynamic pricing models that reduced churn by 8%',
    'Wrote dynamic programming solutions for routing',
  ])('%s', b => expect(problems(b)).toEqual([]))
  it('still flags what it is meant to flag', () => {
    expect(problems('I led the intake team and cut waits').join(' ')).toMatch(/first person/)
    expect(problems('Passionate about dynamic teams and results').join(' ')).toMatch(/banned word/)
    expect(problems('Responsible for weekly reporting').join(' ')).toMatch(/opens with/)
  })
})
