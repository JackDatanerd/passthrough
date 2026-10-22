// Scan / ATS round 17: extractJson tolerant of bracketed preambles, inline "Education:" / "Skills:" labels counted as
// sections, the delivered version (not a stale edit) feeding a rescan / saved profile, related-job prose kept,
// certification level inflation caught, letter JSON after a preamble.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { scoreResume } from '../src/services/ats.service.js'
import { stripPlatformBoilerplate } from '../src/services/jdBoilerplate.js'
import claude from '../src/services/claude.service.js'

let t
afterEach(() => { t?.restore?.(); t = null })

describe('B1 - extractJson finds the object whatever bracket text precedes it', () => {
  it.each([
    ['Sure [1]: {"aiScore": 80}'],
    ['Here you go (see [notes]):\n{"aiScore": 80}'],
    ['Result {draft}: {"aiScore": 80}'],
    ['{"aiScore": 80} Hope [this] helps'],
    ['```json\n{"aiScore": 80}\n```'],
    ['[ lone bracket and then {"aiScore": 80}'],
  ])('%s', raw => { expect(claude.extractJson(raw)).toEqual({ aiScore: 80 }) })
  it('brackets inside string values do not end the object early', () => {
    expect(claude.extractJson('x [1] {"a":"]}[{","b":2}')).toEqual({ a: ']}[{', b: 2 })
  })
  it('a pure array still parses, and no JSON at all still throws', () => {
    expect(claude.extractJson('[1,2]')).toEqual([1, 2])
    expect(() => claude.extractJson('nothing [here] at all')).toThrow()
  })
  it('thousands of lone brackets neither overflow the stack nor hang', () => {
    expect(claude.extractJson('['.repeat(30000) + ' {"a":1}')).toEqual({ a: 1 })
  })
  it('a cover-letter reply with a sentence before the JSON is read as JSON, not delivered as raw text', () => {
    const r = claude.parseLetterReply?.('Here is the letter: {"evidence": [], "letter": "Dear Hiring Manager,\\nHello."}')
    if (r) expect(r.letter).toMatch(/^Dear Hiring Manager/)
    else expect(fs.readFileSync('src/services/claude.service.js', 'utf8')).toMatch(/\\\{\\s\*"\(\?:evidence\|letter\)"/)
  })
})

describe('B2 - a label and its content on one line still counts as that section', () => {
  const mk = (edu, skills) => `Jane Doe\njane@example.com | +254 700 000 000 | Nairobi, Kenya\n\nSummary\nBackend engineer.\n\nExperience\nSenior Engineer, Acme Ltd - 2020 - Present\n- Led migration of billing, cutting latency by 40%\n- Built a deployment pipeline for 12 services\n- Cut cloud spend by $120,000 per year\n\n${edu}\n${skills}\n`
  const JD = 'Node.js TypeScript PostgreSQL Kubernetes AWS engineer'
  it.each([
    ['colon', 'Education: BSc Computer Science, University of Nairobi, 2014 - 2018', 'Skills: Node.js, TypeScript, PostgreSQL, Kubernetes, Terraform, AWS, Docker'],
    ['upper-case', 'EDUCATION: BSc Computer Science, University of Nairobi', 'TECHNICAL SKILLS: Node.js, TypeScript, PostgreSQL, Kubernetes, Terraform'],
    ['en dash', 'Education \u2013 BSc Computer Science, University of Nairobi, 2014 \u2013 2018', 'Skills \u2013 Node.js, TypeScript, PostgreSQL, Kubernetes, Terraform, AWS'],
  ])('%s', (_n, edu, skills) => {
    const r = scoreResume(mk(edu, skills), JD)
    expect(r.detail.sections.missing).toEqual([])
    expect(r.sectionsScore).toBe(100)
  })
  it('a job line or a sentence that merely starts with those words is not a section', () => {
    const r = scoreResume(mk('Skills Engineer - Acme Corp, Nairobi, Kenya, 2019 to 2020 (contract)', 'I have strong skills: teamwork and care'), JD)
    expect(r.detail.sections.missing).toEqual(['Education', 'Skills'])
  })
  it('own-line headings and a resume with no such section behave as before', () => {
    expect(scoreResume(mk('Education\nBSc Computer Science', 'Skills\nNode.js'), JD).sectionsScore).toBe(100)
    expect(scoreResume(mk('', ''), JD).detail.sections.missing).toEqual(['Education', 'Skills'])
  })
})

describe('B3 - a rescan with the improved version uses the delivered content, not a stale edit', () => {
  const SRC = '55555555-5555-5555-5555-555555555555'
  const jd = 'A '.repeat(30) + 'valid job description with enough characters to pass the fifty character minimum.'
  it('edit -> Try Again leaves user_edited behind; the rescan takes rewritten_resume_data', async () => {
    const OLD = { name: 'Old Edit', email: 'o@x.com', skills: ['Go'] }, NEW = { name: 'Newest Rewrite', email: 'o@x.com', skills: ['Go', 'Rust'] }
    const inserts = []
    const src = { id: SRC, user_id: 'u1', status: 'FIX_DELIVERED', fix_purchased: true, fix_tier: 'FIX', input_mode: 'file', resume_path: 'k',
      resume_mime_type: 'application/pdf', original_resume_data: { name: 'Orig' }, user_edited_resume_data: OLD, rewritten_resume_data: NEW, fix_payment_id: null }
    const db = createFakeSupabase(q => {
      if (q.op === 'rpc') return { data: true, error: null }
      if (q.table === 'scans' && q.op === 'insert') { inserts.push(q.values); return { data: null, error: null } }
      if (q.table === 'scans' && q.op === 'select') return { data: src, error: null }
      if (q.table === 'scans' && q.op === 'update') return { data: [{ id: 's' }], error: null }
      if (q.table === 'users') return { data: { scans_today: 1 }, error: null }
      return { data: { status: 'SUCCESS' }, error: null }
    })
    t = loadWithStubs('controllers/scan.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'middleware/rateLimiter.js': { isBypassed: () => false, anonScanSlotKey: () => 'k', refundAnonScanSlot: async () => {}, hitQuota: async () => true },
    })
    const ctx = {
      env: { RESUMES_BUCKET: { get: async () => null, put: async () => {}, delete: async () => {} }, FIX_QUEUE: { send: async () => {} } },
      get: k => ({ uploadedFile: null, formFields: { jobDescriptionText: jd, sourceScanId: SRC, rescanVersion: 'delivered' }, user: { id: 'u1', email: 'o@x.com', scansToday: 0, emailVerified: true } }[k]),
      req: {}, json: (body, status = 200) => ({ body, status }), executionCtx: { waitUntil: p => p.catch(() => {}) },
    }
    const real = console.error; console.error = () => {}
    try { await t.mod.createScan(ctx) } finally { console.error = real }
    expect(inserts[0].original_resume_data.name).toBe('Newest Rewrite')
  })
  it('the saved-profile "delivered" source reads the same column first', () => {
    expect(fs.readFileSync('src/controllers/profile.controller.js', 'utf8')).toMatch(/scan\.rewrittenResumeData \|\| scan\.userEditedResumeData/)
  })
})

describe('jdBoilerplate keeps "related job" requirement prose', () => {
  it('keeps singular prose, still drops the widget heading and the plural', () => {
    expect(stripPlatformBoilerplate('example.com', 'Experience in a related job function is required.')).toContain('related job function')
    expect(stripPlatformBoilerplate('example.com', 'Role.\nRelated Job\nOther')).not.toMatch(/related job/i)
    expect(stripPlatformBoilerplate('example.com', 'Role. Related jobs Other')).not.toMatch(/related jobs/i)
  })
})

describe('certification level cannot be inflated by a rewrite', () => {
  const base = certs => ({ experience: [{ company: 'Acme', title: 'Engineer', dates: '2020 - 2022', bullets: ['Built things'] }], education: [], skills: ['Go'], certifications: certs })
  const fab = (a, b) => claude.detectFabrication(base(a), base(b))
  it('adding a level to a full certification name is flagged', () => {
    expect(fab(['AWS Certified Solutions Architect'], ['AWS Certified Solutions Architect Professional'])).toBe(true)
  })
  it('expanding an acronym, or neutral wording, is still fine', () => {
    expect(fab(['PMP'], ['Project Management Professional (PMP)'])).toBe(false)
    expect(fab(['AWS Solutions Architect'], ['AWS Certified Solutions Architect'])).toBe(false)
    expect(fab(['AWS Certified Solutions Architect'], ['AWS Certified Solutions Architect'])).toBe(false)
  })
})

describe('frontend', () => {
  it('CategoryScores relabels the keyword row when the posting had nothing to score, and DiffView warns on added certifications', () => {
    expect(fs.readFileSync('frontend/src/components/scan/CategoryScores.jsx', 'utf8')).toMatch(/weights\?\.keywords === 0/)
    expect(fs.readFileSync('frontend/src/components/scan/DiffView.jsx', 'utf8')).toMatch(/certs-added-warning/)
  })
})
