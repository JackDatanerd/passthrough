// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import api, { LONG_REQUEST_TIMEOUT_MS } from '../src/lib/api'
import { buildResumeDiff, alignBullets, wordSegments } from '../src/lib/resumeDiff'
import DiffView from '../src/components/scan/DiffView'
import AtsDetailPanel from '../src/components/scan/AtsDetailPanel'
import QuantificationPrompts, { replaceBullet } from '../src/components/scan/QuantificationPrompts'

// Scan / ATS round 4 — the diff, the free-scan detail, inline quantification, and long-call timeouts.

// ── timeouts ────────────────────────────────────────────────────────────────────────────────────────────
describe('PATCH timeouts: saving an edit to a delivered resume re-scores, regenerates HTML and renders a PDF in one request', () => {
  function capture() {
    const seen = []
    return { seen, adapter: cfg => { seen.push({ url: cfg.url, method: cfg.method, timeout: cfg.timeout }); return Promise.resolve({ data: {}, status: 200, statusText: 'OK', headers: {}, config: cfg }) } }
  }
  it('PATCH /delivered-resume and /resume-data get the long timeout, query string included', async () => {
    const { seen, adapter } = capture()
    await api.patch('/scan/abc/delivered-resume', {}, { adapter })
    await api.patch('/scan/abc/resume-data', {}, { adapter })
    await api.patch('/scan/abc/resume-data?token=t%201', {}, { adapter })
    expect(seen.map(s => s.timeout)).toEqual([LONG_REQUEST_TIMEOUT_MS, LONG_REQUEST_TIMEOUT_MS, LONG_REQUEST_TIMEOUT_MS])
  })
  it('other PATCHes keep 30s, and an explicit caller timeout still wins', async () => {
    const { seen, adapter } = capture()
    await api.patch('/scan/abc/verify-visibility', {}, { adapter })
    await api.patch('/scan/abc/delivered-resume', {}, { adapter, timeout: 5_000 })
    await api.patch('/scan/abc/delivered-resume', {}, { adapter, timeout: 30_000, __customTimeout: true })
    expect(seen.map(s => s.timeout)).toEqual([30_000, 5_000, 30_000])
  })
})

// ── resumeDiff ──────────────────────────────────────────────────────────────────────────────────────────
describe('bullets are paired by shared words, not by position', () => {
  const before = ['Built REST services for finance tools', 'Improved reporting speed by rewriting slow queries', 'Led a team of 3 engineers on a billing migration', 'Maintained deployment scripts']
  const after  = ['Led a team of 3 engineers on a billing migration', 'Built scalable REST services for internal finance tools', 'Maintained deployment scripts', 'Cut report time by 40% by rewriting slow queries']
  it('a reordered, partly reworded list shows only the real edits (position matching called all four "changed")', () => {
    const out = alignBullets(before, after)
    expect(out.map(b => b.status)).toEqual(['unchanged', 'changed', 'unchanged', 'changed'])
    expect(out[0].moved).toBe(true)
    expect(out[1].before).toBe('Built REST services for finance tools')
  })
  it('a bullet that was dropped is reported once, at the end; a new one is "added"', () => {
    const out = alignBullets(['Alpha beta gamma delta', 'Totally different line about something else entirely'], ['Alpha beta gamma delta epsilon', 'Brand new accomplishment with other words'])
    expect(out.map(b => b.status)).toEqual(['changed', 'added', 'removed'])
  })
  it('identical bullets stay with their identical partner even when duplicated', () => {
    const out = alignBullets(['Same line here today', 'Same line here today', 'Other'], ['Other', 'Same line here today', 'Same line here today'])
    expect(out.filter(b => b.status === 'unchanged')).toHaveLength(3)
  })
  it('equal-length lists with nothing in common are one removal and one addition per slot, never a fake "rewrite"', () => {
    const out = alignBullets(['aaa bbb ccc'], ['xxx yyy zzz'])
    expect(out.map(b => b.status).sort()).toEqual(['added', 'removed'])
  })
  it('tolerates wrong-typed values without throwing', () => {
    expect(() => alignBullets([1, null, { a: 1 }], ['ok line', undefined])).not.toThrow()
    expect(alignBullets([], [])).toEqual([])
  })
})

describe('word-level segments', () => {
  it('marks only the words that differ', () => {
    const { beforeSegments, afterSegments } = wordSegments('Built REST services', 'Built scalable REST services for finance')
    expect(beforeSegments).toEqual([{ type: 'same', text: 'Built REST services' }])
    expect(afterSegments.filter(s => s.type === 'add').map(s => s.text.trim())).toEqual(['scalable', 'for finance'])
  })
  it('reassembles to the original text on both sides', () => {
    const a = 'Reduced churn by 12% across two regions', b = 'Reduced customer churn by 15% across three regions'
    const { beforeSegments, afterSegments } = wordSegments(a, b)
    expect(beforeSegments.map(s => s.text).join('')).toBe(a)
    expect(afterSegments.map(s => s.text).join('')).toBe(b)
  })
  it('gives up (null) on a pathological bullet rather than stalling the page', () => {
    expect(wordSegments('word '.repeat(300), 'other '.repeat(300))).toBe(null)
  })
})

describe('sections the diff never showed', () => {
  const o = { name: 'J', experience: [{ company: 'Foo', title: 'Dev', dates: '2020', location: 'Nairobi', bullets: ['Did a thing for the team'] }],
    education: [{ institution: 'Uni', degree: 'BSc', dates: '2019', details: 'First class' }], languages: ['English'], awards: ['Award A'], publications: [],
    volunteer: [{ organization: 'Charity', role: 'Mentor', dates: '2021', bullets: ['Taught coding to teenagers every week'] }] }
  it('reports a changed job location and education details', () => {
    const r = JSON.parse(JSON.stringify(o)); r.experience[0].location = 'Remote'; r.education[0].details = 'Second class'
    const d = buildResumeDiff(o, r)
    expect(d.experience[0]).toMatchObject({ locationChanged: true, beforeLocation: 'Nairobi', afterLocation: 'Remote' })
    expect(d.education[0]).toMatchObject({ detailsChanged: true, afterDetails: 'Second class' })
    expect(buildResumeDiff(o, JSON.parse(JSON.stringify(o))).experience[0].locationChanged).toBe(false)
  })
  it('diffs languages, awards, publications and volunteer work', () => {
    const r = JSON.parse(JSON.stringify(o)); r.languages.push('French'); r.awards = []; r.volunteer[0].bullets = ['Taught coding to teenagers every Saturday']
    const d = buildResumeDiff(o, r)
    expect(d.languages.added).toEqual(['French'])
    expect(d.awards.removed).toEqual(['Award A'])
    expect(d.volunteer[0]).toMatchObject({ company: 'Charity', titleChanged: false })
    expect(d.volunteer[0].bullets[0].status).toBe('changed')
  })
  it('older stored resumes without these sections still diff', () => {
    const d = buildResumeDiff({ name: 'J', experience: [] }, { name: 'J', experience: [] })
    expect(d.languages).toEqual({ unchanged: [], removed: [], added: [] })
    expect(d.volunteer).toEqual([])
  })
})

describe('DiffView renders the new detail', () => {
  const base = { name: 'J', experience: [{ company: 'Foo', title: 'Dev', dates: '2020', location: 'Nairobi', bullets: ['Built REST services for finance tools', 'Maintained deployment scripts'] }], education: [], skills: [], certifications: [], projects: [] }
  async function open(rewritten) {
    const user = userEvent.setup()
    render(<DiffView originalResumeData={base} rewrittenResumeData={rewritten} fixTier="FIX" />)
    await user.click(screen.getByRole('button', { name: /see what changed/i }))
  }
  it('highlights the words that changed and tags a moved bullet', async () => {
    await open({ ...base, experience: [{ ...base.experience[0], bullets: ['Maintained deployment scripts', 'Built scalable REST services for finance tools'] }] })
    const changed = screen.getByTestId('bullet-changed')
    expect(within(changed).getByText('scalable')).toBeInTheDocument()
    expect(screen.getAllByText('moved')).toHaveLength(2)          // two bullets swapped places: both are marked
  })
  it('shows a changed location', async () => {
    await open({ ...base, experience: [{ ...base.experience[0], location: 'Remote' }] })
    expect(screen.getByTestId('location-changed')).toHaveTextContent('Nairobi')
    expect(screen.getByTestId('location-changed')).toHaveTextContent('Remote')
  })
  it('shows an added language, but says nothing about an unchanged list', async () => {
    await open({ ...base, languages: ['French'] })
    expect(screen.getByTestId('diff-languages')).toHaveTextContent('French')
    expect(screen.queryByTestId('diff-awards')).toBeNull()
  })
})

// ── the free-scan detail ────────────────────────────────────────────────────────────────────────────────
describe('AtsDetailPanel: what the free scan now explains', () => {
  const detail = (over = {}) => ({ keywords: { matched: ['a'], missing: ['b'], warnings: [] }, sections: { missing: [] }, format: { issues: [] }, content: { actionVerbRate: 0.5, quantifiedCount: 1 }, ...over })
  it('says why a keyword score was reduced', () => {
    render(<AtsDetailPanel scan={{}} detail={detail({ keywords: { matched: ['a'], missing: [], warnings: ['6 of the 8 job-description terms appear only in a skills list'] } })} />)
    expect(screen.getByTestId('keyword-warnings')).toHaveTextContent('Why your keyword score was reduced')
    expect(screen.getByTestId('keyword-warnings')).toHaveTextContent(/^.*6 of the 8 job-description terms appear only in a skills list\./s)
  })
  it('lists the bullets that have no number — before anyone pays for anything', () => {
    render(<AtsDetailPanel scan={{}} detail={detail({ content: { quantifiedCount: 0, unquantified: { count: 7, total: 9, examples: ['Built REST services for the finance team', 'Maintained deployment scripts'] } } })} />)
    const box = screen.getByTestId('unquantified-bullets')
    expect(box).toHaveTextContent('7 of 9 bullets say what you did but give no number')
    expect(box).toHaveTextContent('Maintained deployment scripts')
    expect(box).toHaveTextContent('…and 5 more.')
  })
  it('a resume whose bullets all carry numbers shows neither', () => {
    render(<AtsDetailPanel scan={{}} detail={detail({ content: { quantifiedCount: 5, unquantified: { count: 0, total: 5, examples: [] } } })} />)
    expect(screen.queryByTestId('unquantified-bullets')).toBeNull()
    expect(screen.queryByTestId('keyword-warnings')).toBeNull()
  })
  it('tells a non-English resume that the verb check was skipped, and never shows a made-up percentage', () => {
    render(<AtsDetailPanel scan={{}} detail={detail({ content: { language: 'other', actionVerbRate: null, quantifiedCount: 2 } })} />)
    expect(screen.getByTestId('language-note')).toBeInTheDocument()
    expect(screen.queryByText(/start with a strong action verb/)).toBeNull()
  })
  it('older stored reports without the new fields render exactly as before', () => {
    render(<AtsDetailPanel scan={{}} detail={{ keywords: { matched: ['a'], missing: ['b'] }, sections: {}, format: {}, content: {} }} />)
    expect(screen.getByText('Keywords from the job description not found in your resume')).toBeInTheDocument()
  })
})

// ── inline quantification ───────────────────────────────────────────────────────────────────────────────
describe('replaceBullet', () => {
  const data = { experience: [{ bullets: ['First line', 'Second line'] }, { bullets: ['Third line'] }] }
  it('replaces the matching bullet in a copy and leaves the original alone', () => {
    const out = replaceBullet(data, ' Third line ', 'Third line, for 12 clients')
    expect(out.experience[1].bullets).toEqual(['Third line, for 12 clients'])
    expect(data.experience[1].bullets).toEqual(['Third line'])
  })
  it('returns null when the bullet is gone or the data is unusable', () => {
    expect(replaceBullet(data, 'Nope', 'x')).toBe(null)
    expect(replaceBullet(null, 'a', 'b')).toBe(null)
    expect(replaceBullet({ experience: 'x' }, 'a', 'b')).toBe(null)
  })
})

describe('QuantificationPrompts: add the number right where the suggestion is', () => {
  const prompts = [{ bullet: 'Improved report speed for the data team', suggestion: 'By how much?' }]
  const scan = { id: 's1', rewrittenResumeData: { name: 'J', experience: [{ company: 'Foo', bullets: ['Improved report speed for the data team', 'Other line'] }] } }
  beforeEach(() => { vi.spyOn(api, 'patch').mockReset() })
  it('without a save handler (not the owner) it is the same read-only suggestion list as before', () => {
    render(<QuantificationPrompts prompts={prompts} scan={scan} onSaved={null} />)
    expect(screen.getByText('By how much?')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add my number' })).toBeNull()
    expect(screen.getByText(/use "Edit your delivered resume" below/)).toBeInTheDocument()
  })
  it('renders nothing when there are no prompts', () => {
    const { container } = render(<QuantificationPrompts prompts={[]} scan={scan} onSaved={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
  it('saves the edited bullet through the delivered-resume endpoint and hands the result up', async () => {
    const user = userEvent.setup(); const onSaved = vi.fn()
    api.patch.mockResolvedValue({ data: { data: { fixAtsScore: 84, quantificationPrompts: [] } } })
    render(<QuantificationPrompts prompts={prompts} scan={scan} onSaved={onSaved} />)
    await user.click(screen.getByRole('button', { name: 'Add my number' }))
    const box = screen.getByLabelText('Edit this bullet')
    expect(screen.getByRole('button', { name: 'Save and rebuild' })).toBeDisabled()          // unchanged text
    await user.clear(box); await user.type(box, 'Improved report speed by 40% for the data team')
    await user.click(screen.getByRole('button', { name: 'Save and rebuild' }))
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1))
    const [url, body] = api.patch.mock.calls[0]
    expect(url).toBe('/scan/s1/delivered-resume')
    expect(body.resumeData.experience[0].bullets).toEqual(['Improved report speed by 40% for the data team', 'Other line'])
    expect(body.resumeData.name).toBe('J')
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ fixAtsScore: 84, quantificationPrompts: [] }))
  })
  it('nudges toward a real figure when the text has none, but still allows it', async () => {
    const user = userEvent.setup()
    render(<QuantificationPrompts prompts={prompts} scan={scan} onSaved={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Add my number' }))
    const box = screen.getByLabelText('Edit this bullet')
    await user.clear(box); await user.type(box, 'Improved report speed a lot')
    expect(screen.getByText(/Include the figure itself/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save and rebuild' })).toBeEnabled()
  })
  it('a failed save shows the server\'s reason and keeps the field open', async () => {
    const user = userEvent.setup()
    api.patch.mockRejectedValue({ response: { data: { message: 'This purchase was refunded or is under dispute, so it can no longer be changed or regenerated.' } } })
    render(<QuantificationPrompts prompts={prompts} scan={scan} onSaved={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Add my number' }))
    const box = screen.getByLabelText('Edit this bullet')
    await user.type(box, ' by 40%')
    await user.click(screen.getByRole('button', { name: 'Save and rebuild' }))
    expect(await screen.findByText(/refunded or is under dispute/)).toBeInTheDocument()
    expect(screen.getByLabelText('Edit this bullet')).toBeInTheDocument()
  })
  it('a bullet that changed since the page loaded is not overwritten blind', async () => {
    const user = userEvent.setup()
    render(<QuantificationPrompts prompts={[{ bullet: 'A line that is no longer there', suggestion: 's' }]} scan={scan} onSaved={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Add my number' }))
    await user.type(screen.getByLabelText('Edit this bullet'), ' by 3%')
    await user.click(screen.getByRole('button', { name: 'Save and rebuild' }))
    expect(await screen.findByText(/has changed since this page loaded/)).toBeInTheDocument()
    expect(api.patch).not.toHaveBeenCalled()
  })
  it('Cancel puts the original text back', async () => {
    const user = userEvent.setup()
    render(<QuantificationPrompts prompts={prompts} scan={scan} onSaved={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Add my number' }))
    await user.type(screen.getByLabelText('Edit this bullet'), ' by 40%')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByRole('button', { name: 'Add my number' }))
    expect(screen.getByLabelText('Edit this bullet')).toHaveValue('Improved report speed for the data team')
  })
})
