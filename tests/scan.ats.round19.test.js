import { describe, it, expect, afterEach } from 'vitest'
import { generateCoverLetter } from '../src/services/claude.service.js'
import { countQuantifiedFigures, scoreResume } from '../src/services/ats.service.js'

describe('R19: a later cover-letter attempt that fails does not discard a usable earlier draft', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })
  const letter = (extra) => `Dear Hiring Manager,\n\nI am writing to apply for the backend role ${extra}. My work at Acme building services for customers matches what your team needs, and I would welcome the chance to talk about it in more detail.\n\nSincerely,\nJane Doe`
  const reply = (text, stop = 'end_turn') => new Response(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 })
  const data = { name: 'Jane Doe', experience: [{ company: 'Acme', title: 'Engineer', dates: '2020', bullets: ['Built services'] }] }
  const jd = 'Backend engineer wanted. Python and Django.'
  const run = () => generateCoverLetter({ ANTHROPIC_API_KEY: 'k' }, data, jd)

  it('keeps the style-only draft when attempt 2 is truncated', async () => {
    let n = 0
    globalThis.fetch = async () => (++n === 1 ? reply(letter('today')) : reply('{"letter": "cut', 'max_tokens'))
    const r = await run()
    expect(r.success).toBe(true); expect(r.data).toContain('Dear Hiring Manager')
  })
  it('keeps it when attempt 2 is an API failure', async () => {
    let n = 0
    globalThis.fetch = async () => (++n === 1 ? reply(letter('today')) : new Response(JSON.stringify({ error: { message: 'prompt is too long' } }), { status: 400 }))
    const r = await run()
    expect(r.success).toBe(true)
  })
  it('keeps it when attempt 2 is too short to be a letter', async () => {
    let n = 0
    globalThis.fetch = async () => (++n === 1 ? reply(letter('today')) : reply('{"evidence": [], "letter": "Hi"}'))
    const r = await run()
    expect(r.success).toBe(true)
  })
  it('with no earlier draft the failure is still reported', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'prompt is too long' } }), { status: 400 })
    const r = await run()
    expect(r.success).toBe(false)
  })
})

describe('R19: dates and versions are not quantified achievements', () => {
  const n = s => countQuantifiedFigures(`EXPERIENCE\nAcme\n- ${s}\n`)
  it.each([
    'Launched the product on 14 March for the sales team',
    'Worked from 2 January through the end of the project',
    'Worked 5 September to cover support for the team',
    'Delivered the 2021 roadmap on time for the platform team',
    'Rolled out changes in 2021 across several teams',
    'Migrated the services to Python 3 with care',
    'Upgraded the clients to Java 17 and iOS 14 gradually',
  ])('%s => 0', s => expect(n(s)).toBe(0))
  it.each([
    'Cut costs by 15 percent',
    'Served 2000 users across the region',
    'Managed 12 engineers on the team',
    'Grew revenue to $2M for the company',
  ])('real figure still counts: %s', s => expect(n(s)).toBeGreaterThan(0))
})

describe('R19: a thin but real resume is scored, not reported as unreadable', () => {
  it('a 40-character resume does not get the "could not be parsed" format result', () => {
    const r = scoreResume('Jane Doe\nData Analyst\nSQL Python Tableau', 'Data analyst with SQL and Python.')
    expect(JSON.stringify(r.detail)).not.toContain('could not be parsed')
  })
  it('an empty resume is still unparsed', () => {
    expect(scoreResume('', 'Data analyst.').formatScore).toBe(0)
  })
})
