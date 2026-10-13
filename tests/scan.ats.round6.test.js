import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import JSZip from 'jszip'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { scoreResume, resumeEvidenceZones, displayKeyword } from '../src/services/ats.service.js'
import { generateAtsDocx } from '../src/services/docx.service.js'
import { extractText } from '../src/services/resume.parser.js'
import { normalizeJobUrl, fetchJobDescriptionFromUrl } from '../src/services/jd.parser.js'
import { findPlaceholders, generateCoverLetter, scoreResumeWithAI } from '../src/services/claude.service.js'
import { handleDeadLetterBatch } from '../src/services/deadletter.service.js'

const req = createRequire(import.meta.url)
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

let realErr; beforeEach(() => { realErr = console.error; console.error = () => {} }); afterEach(() => { console.error = realErr })

const JD = `Senior Backend Engineer
Requirements
Python, Django, PostgreSQL, Redis, Docker, Kubernetes, AWS, Terraform, GraphQL, Kafka
You will design REST APIs and own CI/CD pipelines.`
const resumeWith = first => `Jane Doe
jane@x.com | +254 700 000 000
Experience
Backend Engineer, Acme  2020 - 2024
• ${first}
• Built Django and Python REST APIs backed by PostgreSQL and Redis
• Containerised services with Docker and ran them on Kubernetes in AWS
• Provisioned infrastructure with Terraform
• Designed GraphQL gateway and Kafka event pipeline
• Reduced p99 latency by 40%
Education
BSc Computer Science
`

describe('B1: a bullet is not a Skills heading', () => {
  it.each(['Built internal tools', 'Improved data technologies', 'Led expertise sessions', 'Grew sales skills'])('"%s" no longer flips the zone', bullet => {
    const z = resumeEvidenceZones(resumeWith(bullet))
    expect(z.hasSkillsZone).toBe(false)
    expect(z.evidence).toContain('Containerised services with Docker')
  })
  it('scores the same with or without the trailing period (it used to drop 78 -> 39 on keywords)', () => {
    const a = scoreResume(resumeWith('Built internal tools'), JD), b = scoreResume(resumeWith('Built internal tools.'), JD)
    expect(a.keywordScore).toBe(b.keywordScore)
    expect(a.detail.keywords.integrity.stuffed).toBe(false)
    expect(a.detail.keywords.warnings).toEqual([])
  })
  it('still recognises real headings, in every form', () => {
    for (const h of ['Skills', 'SKILLS', 'Technical Skills', 'Core Competencies', 'Skills & Tools', 'Tools and Technologies', 'Areas of Expertise', 'Key Skills', 'Habilidades']) {
      const z = resumeEvidenceZones(`Jane\nExperience\nEngineer at Acme building services for customers every day\n${h}\npython, aws, docker`)
      expect(z.skills, h).toContain('python, aws, docker')
      expect(z.hasSkillsZone, h).toBe(true)
    }
  })
  it('a real skills heading after Experience still catches a stuffed list', () => {
    const stuffed = `Jane Doe\njane@x.com\nExperience\nClerk, Acme 2020 - 2024\n• Filed paperwork for the office\n• Answered the phone\nSkills\nPython, Django, PostgreSQL, Redis, Docker, Kubernetes, AWS, Terraform, GraphQL, Kafka\nEducation\nBSc`
    expect(scoreResume(stuffed, JD).detail.keywords.integrity.stuffed).toBe(true)
  })
  it('compound and unusual section headings still END a skills list (the old recall is kept)', () => {
    for (const h of ['Certifications & Licenses', 'Honors & Awards', 'Education & Training', 'Awards and Achievements', 'Projects & Research', 'Interests & Hobbies', 'Publications & Patents',
      'PROFESSIONAL EXPERIENCE', 'Work Experience', 'Relevant Coursework', 'Additional Information', 'Leadership & Activities', 'Professional Development']) {
      const z = resumeEvidenceZones(`Jane\nSkills\npython, aws\n${h}\nBuilt a platform in python for customers`)
      expect(z.skills, h).not.toContain('Built a platform')
      expect(z.evidence, h).toContain('Built a platform')
    }
  })
  it('a job-title line is not a Skills heading either ("Tools Engineer" used to flip the zone)', () => {
    for (const l of ['Tools Engineer', 'Software Tools Engineer', 'Skills Development Lead', 'Built Internal Tools'])
      expect(resumeEvidenceZones(`Jane\nExperience\nEngineer at Acme building things for customers\n${l}\nShipped the python platform`).hasSkillsZone, l).toBe(false)
  })
  it('a bullet that starts with a glyph is never a heading, even a one-word one', () => {
    expect(resumeEvidenceZones('Jane\nExperience\n• Skills\n• Led the team of engineers in daily planning').hasSkillsZone).toBe(false)
  })
  it('"Skills-based hiring" style text is not an inline skills line', () => {
    expect(resumeEvidenceZones('Jane\nExperience\nSkills-based hiring pipeline owner for the whole company').hasSkillsZone).toBe(false)
    expect(resumeEvidenceZones('Jane\nSkills: python, aws').skills).toBe('python, aws')
    expect(resumeEvidenceZones('Jane\nSkills - python, aws').skills).toBe('python, aws')
  })
  it('end to end on a REAL generated docx: the delivered file keeps its score', async () => {
    const data = { name: 'Jane Doe', email: 'jane@x.com', phone: null, location: null, linkedin: null, portfolio: null, summary: null,
      experience: [{ company: 'Acme', title: 'Engineer', dates: '2020 - 2024', location: null, bullets: ['Built internal tools', 'Built Django and Python REST APIs backed by PostgreSQL and Redis', 'Containerised services with Docker and ran them on Kubernetes in AWS', 'Provisioned infrastructure with Terraform', 'Designed GraphQL gateway and Kafka event pipeline', 'Reduced p99 latency by 40%'] }],
      education: [{ institution: 'UoN', degree: 'BSc Computer Science', dates: '2016 - 2020', details: null }], skills: ['Python', 'Django'], certifications: [], projects: [], languages: [], awards: [], publications: [], volunteer: [] }
    const text = await extractText(await generateAtsDocx(data, null), DOCX)
    const r = scoreResume(text, JD)
    expect(r.detail.keywords.integrity.stuffed).toBe(false)
    expect(r.detail.keywords.integrity.skillsOnly).toBe(0)
  })
})

describe('B4: "&" and "+" in a job description do not create phrases a resume cannot match', () => {
  const jd = 'Operations Analyst\nRequirements\nExperience in Research & Development and Sales & Marketing environments. Strong Excel & SQL skills.'
  const mk = line => `Jane Doe\njane@x.com\nExperience\nAnalyst, Acme 2020 - 2024\n• ${line}\n• Reported weekly results to leadership\nEducation\nBSc Statistics\nSkills\nExcel, SQL`
  it('"and" and "&" in the resume score identically', () => {
    const a = scoreResume(mk('Worked in research and development and sales and marketing teams using Excel and SQL'), jd)
    const b = scoreResume(mk('Worked in research & development and sales & marketing teams using Excel & SQL'), jd)
    expect(a.keywordScore).toBe(b.keywordScore)
    expect(a.detail.keywords.missing).not.toContain('research development')
    expect(a.detail.keywords.missing).not.toContain('sales marketing')
  })
  it('"HTML + CSS" does not become an adjacency requirement either', () => {
    const r = scoreResume(mk('Built pages with HTML and CSS'), 'Web Developer\nRequirements\nHTML + CSS')
    expect(r.detail.keywords.missing).not.toContain('html css')
  })
})

describe('G5: Node.js costs one concept, not three, and reads as itself', () => {
  it('shows Node.js, never a bare "js"', () => {
    const r = scoreResume(resumeWith('Wrote Node.js services'), 'Engineer\nRequirements\nNode.js, Next.js, Docker')
    const all = [...r.detail.keywords.matched, ...r.detail.keywords.missing]
    expect(all).not.toContain('js')
    expect(r.detail.keywords.matched).toContain('Node.js')
    expect(displayKeyword('next js')).toBe('Next.js')
    expect(displayKeyword('docker k8s')).not.toMatch(/\./)
  })
})

describe('B6: a self-closing <w:t/> in a docx does not leak raw XML into the text', () => {
  async function docx(body) {
    const z = new JSZip()
    z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>')
    z.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`)
    return z.generateAsync({ type: 'uint8array' })
  }
  const p = t => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`
  it('empty runs vanish; real text survives', async () => {
    for (const empty of ['<w:t/>', '<w:t xml:space="preserve"/>', '<w:t />']) {
      const text = await extractText(await docx(p('Jane Doe') + `<w:p><w:r>${empty}</w:r><w:r><w:t>Software Engineer</w:t></w:r></w:p>` + p('jane@x.com')), DOCX)
      expect(text).toBe('Jane Doe\nSoftware Engineer\njane@x.com')
      expect(text).not.toMatch(/<\/?w:/)
    }
  })
  it('tabs, split runs and ordinary runs are untouched', async () => {
    const text = await extractText(await docx(p('Jane Doe') + '<w:p><w:r><w:t>Led team</w:t></w:r><w:r><w:t xml:space="preserve"> of 5</w:t></w:r></w:p><w:p><w:r><w:t>Skills:</w:t></w:r><w:r><w:tab/><w:t>Python</w:t></w:r></w:p>'), DOCX)
    expect(text).toBe('Jane Doe\nLed team of 5\nSkills:\tPython')
  })
})

describe('B3: cover-letter file name', () => {
  const { coverLetterFileStem, draftFileStem } = req('../src/controllers/scan.controller.js').__test
  it('uses the name when there is one', () => expect(coverLetterFileStem({ name: 'Jane Doe' })).toBe('jane-doe-cover-letter'))
  it('is "cover-letter" — never "resume-draft-cover-letter" — with no usable name', () => {
    for (const d of [null, {}, { name: '' }, { name: '李雷' }, { name: '   ' }]) expect(coverLetterFileStem(d)).toBe('cover-letter')
  })
  it('the draft names are unchanged', () => {
    expect(draftFileStem({ name: 'Jane Doe' })).toBe('jane-doe-resume-draft')
    expect(draftFileStem(null)).toBe('resume-draft')
  })
})

describe('B5: a dead-lettered free scan gets its slot back by the same rule as every other failure', () => {
  const rl = req('../src/middleware/rateLimiter.js')
  const alerts = { sendOwnerAlert: async () => {} }
  const batch = body => ({ messages: [{ id: 'm', attempts: 4, body, ack() {} }] })
  const dbWith = row => createFakeSupabase(q => (q.table === 'scans' && q.op === 'update') ? { data: row ? [row] : [], error: null } : undefined)
  const today = new Date().toISOString()
  const yesterday = new Date(Date.now() - 36 * 3600 * 1000).toISOString()

  it('refunds a retry-scan whose SLOT was spent today on a scan created yesterday (it used to be skipped)', async () => {
    const db = dbWith({ id: 's1', user_id: 'u1', created_at: yesterday, scan_slot_spent_at: today })
    await handleDeadLetterBatch(batch({ type: 'runAtsScan', scanId: 's1' }), {}, db, alerts)
    expect(db.calls.filter(c => c.op === 'rpc' && c.name === 'decrement_scan_count')).toHaveLength(1)
  })
  it('does not refund a slot that belongs to an earlier day', async () => {
    const db = dbWith({ id: 's1', user_id: 'u1', created_at: yesterday, scan_slot_spent_at: null })
    await handleDeadLetterBatch(batch({ type: 'runAtsScan', scanId: 's1' }), {}, db, alerts)
    expect(db.calls.filter(c => c.op === 'rpc')).toHaveLength(0)
  })
  it('hands back the per-IP ceiling slot too', async () => {
    const spy = vi.spyOn(rl, 'refundQuota').mockResolvedValue()
    const db = dbWith({ id: 's1', user_id: 'u1', created_at: today, scan_slot_spent_at: null })
    await handleDeadLetterBatch(batch({ type: 'runAtsScan', scanId: 's1', ipSlotKey: 'scan-ip:1.2.3.4' }), {}, db, alerts)
    expect(spy).toHaveBeenCalledWith({}, 'scan-ip:1.2.3.4', 24 * 3600, 10)
    spy.mockRestore()
  })
  it('refunds an anonymous visitor inside the hour, and only inside it', async () => {
    const spy = vi.spyOn(rl, 'refundAnonScanSlot').mockResolvedValue()
    await handleDeadLetterBatch(batch({ type: 'runAtsScan', scanId: 'a', anonRlKey: 'k' }), {}, dbWith({ id: 'a', user_id: null, created_at: today }), alerts)
    expect(spy).toHaveBeenCalledTimes(1)
    await handleDeadLetterBatch(batch({ type: 'runAtsScan', scanId: 'b', anonRlKey: 'k' }), {}, dbWith({ id: 'b', user_id: null, created_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString() }), alerts)
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
  it('only touches scans still PENDING/SCANNING, and still acks and alerts when the refund throws', async () => {
    const db = createFakeSupabase(q => q.op === 'update' ? { data: [{ id: 's', user_id: 'u', created_at: today }], error: null } : { error: new Error('rpc down') })
    const m = { id: 'm', attempts: 1, body: { type: 'runAtsScan', scanId: 's' }, acked: false, ack() { this.acked = true } }
    const sent = []
    await handleDeadLetterBatch({ messages: [m] }, {}, db, { sendOwnerAlert: async (e, s) => { sent.push(s) } })
    expect(db.calls.find(c => c.op === 'update').filters.find(f => f[0] === 'in' && f[1] === 'status')[2]).toEqual(['PENDING', 'SCANNING'])
    expect(m.acked).toBe(true); expect(sent).toHaveLength(1)
  })
})

describe('G1: the ATS score is requested at temperature 0, and a model that refuses the parameter still scores', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })
  const ok = () => new Response(JSON.stringify({ content: [{ type: 'text', text: '{"aiScore": 70, "missingKeywords": []}' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 })
  it('sends temperature: 0 for scoring', async () => {
    const bodies = []
    globalThis.fetch = async (u, init) => { bodies.push(JSON.parse(init.body)); return ok() }
    const r = await scoreResumeWithAI({ ANTHROPIC_API_KEY: 'k' }, 'resume', 'jd')
    expect(r.success).toBe(true)
    expect(bodies[0].temperature).toBe(0)
  })
  it('on a 400 that names temperature, resends once WITHOUT it and succeeds', async () => {
    const bodies = []
    globalThis.fetch = async (u, init) => {
      bodies.push(JSON.parse(init.body))
      return 'temperature' in bodies.at(-1)
        ? new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: '`temperature` is not supported for this model' } }), { status: 400 })
        : ok()
    }
    const r = await scoreResumeWithAI({ ANTHROPIC_API_KEY: 'k' }, 'resume', 'jd')
    expect(r.success).toBe(true)
    expect(bodies).toHaveLength(2)
    expect('temperature' in bodies[1]).toBe(false)
  })
  it('an unrelated 400 is still fatal and is not retried', async () => {
    let n = 0
    globalThis.fetch = async () => { n++; return new Response(JSON.stringify({ error: { message: 'prompt is too long' } }), { status: 400 }) }
    const r = await scoreResumeWithAI({ ANTHROPIC_API_KEY: 'k' }, 'resume', 'jd')
    expect(r.success).toBe(false); expect(n).toBe(1)
  })
})

describe('G2: a cover letter with placeholders is retried, then refused — never delivered', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })
  const letter = extra => `Dear Hiring Manager,\n\nI am writing about the backend role ${extra}. My work at Acme building services for customers matches what your team needs, and I would welcome the chance to talk about it in more detail.\n\nSincerely,\nJane Doe`
  const reply = text => new Response(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 })
  const data = { name: 'Jane Doe', experience: [{ company: 'Acme', title: 'Engineer', dates: '2020', bullets: ['Built services'] }] }
  it('finds bracketed and templated fill-ins and nothing else', () => {
    expect(findPlaceholders('at [Company Name] and {{role}} and <Your Name>')).toHaveLength(3)
    expect(findPlaceholders('Used React (v18) and C++ [2020]. Led 5 people.')).toEqual([])
  })
  it('retries with feedback and accepts the clean second draft', async () => {
    const prompts = []
    globalThis.fetch = async (u, init) => { const b = JSON.parse(init.body); prompts.push(b.messages[0].content); return reply(prompts.length === 1 ? letter('at [Company Name]') : letter('at your company')) }
    const r = await generateCoverLetter({ ANTHROPIC_API_KEY: 'k' }, data, 'Backend engineer wanted. Python and Django.')
    expect(r.success).toBe(true); expect(r.data).not.toContain('[')
    expect(prompts).toHaveLength(2); expect(prompts[1]).toContain('placeholders')
  })
  it('fails with PLACEHOLDER_DETECTED when the model keeps doing it', async () => {
    globalThis.fetch = async () => reply(letter('at [Company Name]'))
    const r = await generateCoverLetter({ ANTHROPIC_API_KEY: 'k' }, data, 'Backend engineer wanted. Python and Django.')
    expect(r).toMatchObject({ success: false, error: 'PLACEHOLDER_DETECTED' })
  })
  it('an invented figure still reports FABRICATION_DETECTED', async () => {
    globalThis.fetch = async () => reply(letter('after I cut costs by 73%'))
    const r = await generateCoverLetter({ ANTHROPIC_API_KEY: 'k' }, data, 'Backend engineer wanted. Python and Django.')
    expect(r).toMatchObject({ success: false, error: 'FABRICATION_DETECTED' })
  })
})

describe('G3: a job link pasted without a scheme is read, not refused', () => {
  it.each([
    ['jobs.acme.com/eng-1', 'https://jobs.acme.com/eng-1'],
    ['www.acme.com', 'https://www.acme.com'],
    ['  boards.greenhouse.io/acme/jobs/1  ', 'https://boards.greenhouse.io/acme/jobs/1'],
    ['jobs.acme.com:8080/x', 'https://jobs.acme.com:8080/x'],
  ])('%s', (input, out) => expect(normalizeJobUrl(input)).toBe(out))
  it.each(['https://x.com/a', 'http://x.com', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://a.b/c', 'mailto:a@b.co', 'localhost:3000/x', 'not a url', 'acme', ''])('leaves %j alone — the existing validation and SSRF guard still decide', v => expect(normalizeJobUrl(v)).toBe(v))
  it('a scheme-less LinkedIn link is still recognised as LinkedIn', async () => {
    const r = await fetchJobDescriptionFromUrl('linkedin.com/jobs/view/123')
    expect(r.success).toBe(false); expect(r.blocked).toBe(true)
  })
  it('garbage gets a useful message instead of "Invalid URL."', async () => {
    const r = await fetchJobDescriptionFromUrl('not a url')
    expect(r.success).toBe(false); expect(r.message).toMatch(/paste the job description/i)
  })
})
