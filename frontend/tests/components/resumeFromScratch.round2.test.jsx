// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import api from '../../src/lib/api'
import ScanForm from '../../src/components/scan/ScanForm'
import { manualHasContent, missingHints } from '../../src/lib/resumeForm'
import { loadBrainDumpDraft, saveBrainDumpDraft, markDraftSent, clearDraftIfSent, clearBrainDumpDraft, dropForeignBrainDumpDraft } from '../../src/lib/brainDumpDraft'

// Resume-from-scratch round 2: the hand-filled form is kept like the typed background (G1), and a draft is only
// cleared by the result of the scan it produced (B2).
const auth = { user: null }
vi.mock('../../src/hooks/useAuth', () => ({ useAuth: () => auth }))
vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
vi.mock('../../src/components/ui/FileUpload', () => ({ default: () => <div /> }))

const KEY = 'passthrough_brain_dump_draft'
const SENT = 'passthrough_brain_dump_draft_sent'
const MANUAL = { name: 'Jane Doe', email: '', experience: [{ company: 'Acme', title: 'Analyst', dates: '', location: '', bullets: ['Built dashboards'] }] }
const JD = 'Senior backend engineer. Node.js, TypeScript, PostgreSQL, Docker. '.repeat(3)
const renderForm = (url = '/') => render(<MemoryRouter initialEntries={[url]}><ScanForm /></MemoryRouter>)

beforeEach(() => {
  for (const k of ['get', 'post', 'patch', 'delete']) api[k].mockReset()
  api.get.mockResolvedValue({ data: { data: {} } })
  auth.user = null
  localStorage.clear()
})

describe('draft storage keeps the hand-filled form (G1)', () => {
  it('round-trips the form alongside the typed text, and a plain draft keeps its exact old shape', () => {
    saveBrainDumpDraft({ text: 'bg', name: 'J', email: 'j@x.com' })
    expect(loadBrainDumpDraft()).toEqual({ text: 'bg', name: 'J', email: 'j@x.com' })
    saveBrainDumpDraft({ text: 'bg', manual: MANUAL })
    expect(loadBrainDumpDraft().manual).toEqual(MANUAL)
  })
  it('a form that holds only a name or contact details is not a draft (a pre-filled account name would otherwise be one)', () => {
    saveBrainDumpDraft({ manual: { name: 'Jane', email: 'j@x.com', phone: '1' } })
    expect(loadBrainDumpDraft()).toBeNull()
    expect(localStorage.getItem(KEY)).toBeNull()
  })
  it('a form-only draft survives; emptying the form removes it', () => {
    saveBrainDumpDraft({ manual: MANUAL })
    expect(loadBrainDumpDraft().manual.experience[0].company).toBe('Acme')
    saveBrainDumpDraft({ manual: { name: 'Jane', experience: [] } })
    expect(loadBrainDumpDraft()).toBeNull()
  })
  it('a malformed stored form is ignored; ownership still applies to it', () => {
    localStorage.setItem(KEY, JSON.stringify({ text: 'x', manual: 'nope' }))
    expect(loadBrainDumpDraft()).toEqual({ text: 'x', name: '', email: '' })
    saveBrainDumpDraft({ manual: MANUAL, owner: 'user-a' })
    expect(loadBrainDumpDraft('user-b')).toBeNull()
    expect(loadBrainDumpDraft('user-a').manual).toBeTruthy()
    dropForeignBrainDumpDraft('user-b'); expect(localStorage.getItem(KEY)).toBeNull()
  })
})

describe('a draft is cleared only by the result of the scan it produced (B2)', () => {
  it('opening any OTHER scan\'s result leaves a half-typed background alone', () => {
    saveBrainDumpDraft({ text: 'a brand new background I am typing' })
    markDraftSent('scan-old', 'text')
    // the person types more, then opens some unrelated from-scratch result
    expect(clearDraftIfSent('scan-unrelated')).toBe(false)
    expect(loadBrainDumpDraft().text).toMatch(/brand new/)
  })
  it('the sent scan\'s own result clears exactly what was sent', () => {
    saveBrainDumpDraft({ text: 'sent text', name: 'J', email: 'j@x.com' })
    markDraftSent('scan-1', 'text')
    expect(clearDraftIfSent('scan-1')).toBe(true)
    expect(localStorage.getItem(KEY)).toBeNull(); expect(localStorage.getItem(SENT)).toBeNull()
  })
  it('text typed AFTER sending is a new draft: the old scan\'s result does not delete it', () => {
    saveBrainDumpDraft({ text: 'first background' })
    markDraftSent('scan-1', 'text')
    saveBrainDumpDraft({ text: 'first background, then I changed my mind and wrote more' })
    expect(clearDraftIfSent('scan-1')).toBe(false)
    expect(loadBrainDumpDraft().text).toMatch(/changed my mind/)
    expect(localStorage.getItem(SENT)).toBeNull()      // the note is spent either way
  })
  it('sending the typed text does not take a half-filled form with it, and the reverse', () => {
    saveBrainDumpDraft({ text: 'typed background', manual: MANUAL })
    markDraftSent('scan-text', 'text')
    expect(clearDraftIfSent('scan-text')).toBe(true)
    expect(loadBrainDumpDraft()).toMatchObject({ text: '', manual: MANUAL })
    markDraftSent('scan-form', 'manual')
    expect(clearDraftIfSent('scan-form')).toBe(true)
    expect(loadBrainDumpDraft()).toBeNull()
  })
  it('sign-out / session adoption still clears everything, note included', () => {
    saveBrainDumpDraft({ text: 'x' }); markDraftSent('s', 'text')
    clearBrainDumpDraft()
    expect(localStorage.getItem(KEY)).toBeNull(); expect(localStorage.getItem(SENT)).toBeNull()
  })
  it('blocked storage never throws', () => {
    const orig = Storage.prototype.getItem
    Storage.prototype.getItem = () => { throw new Error('blocked') }
    try { expect(() => { markDraftSent('s'); clearDraftIfSent('s') }).not.toThrow() } finally { Storage.prototype.getItem = orig }
  })
  it('the result page clears through clearDraftIfSent(id), not unconditionally', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/pages/ScanResult.jsx'), 'utf8')
    expect(src).toMatch(/clearDraftIfSent\(id\)/)
    expect(src).not.toMatch(/clearBrainDumpDraft\(\)/)
  })
})

describe('ScanForm — the hand-filled form comes back (G1)', () => {
  it('reopens on the form, filled in, with a notice, when only a form was kept', async () => {
    saveBrainDumpDraft({ manual: MANUAL })
    renderForm()
    expect(screen.getByRole('button', { name: 'Fill it in myself' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(/We kept what you were filling in last time/)).toBeInTheDocument()
    expect(screen.getByDisplayValue('Acme')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Built dashboards')).toBeInTheDocument()
  })
  it('an explicit ?mode= link still wins over a kept draft', () => {
    saveBrainDumpDraft({ manual: MANUAL })
    renderForm('/?mode=brainDump')
    expect(screen.getByRole('button', { name: 'Start from scratch' })).toHaveAttribute('aria-pressed', 'true')
  })
  it('with nothing kept it opens on Upload as before', () => {
    renderForm()
    expect(screen.getByRole('button', { name: 'Upload resume' })).toHaveAttribute('aria-pressed', 'true')
  })
  it('a signed-in person starts with their account name and email visible in the form, not added behind their back', async () => {
    auth.user = { id: 'u1', name: 'Account Name', email: 'acct@x.com' }
    const user = userEvent.setup()
    renderForm()
    await user.click(screen.getByRole('button', { name: 'Fill it in myself' }))
    expect(screen.getByLabelText('Name')).toHaveValue('Account Name')
    expect(screen.getByLabelText('Email')).toHaveValue('acct@x.com')
    expect(localStorage.getItem(KEY)).toBeNull()      // pre-filled details alone are not a draft
  })
  it('typing into the form saves it as you go; sending it notes which scan it became', async () => {
    const user = userEvent.setup()
    api.post.mockResolvedValue({ data: { data: { scanId: 'scan-9', anonToken: 't' } } })
    renderForm('/?mode=manual')
    await user.type(screen.getByLabelText('Name'), 'Jane Doe')
    await user.click(screen.getAllByText('+ Add')[0])
    await user.type(screen.getByPlaceholderText('Company'), 'Acme')
    await waitFor(() => expect(loadBrainDumpDraft()?.manual?.experience?.[0]?.company).toBe('Acme'))
    await user.type(screen.getByPlaceholderText(/Paste the full job description/), JD)
    await user.click(screen.getByRole('button', { name: /Score My Resume/ }))
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    await waitFor(() => expect(JSON.parse(localStorage.getItem(SENT))).toMatchObject({ scanId: 'scan-9', mode: 'manual' }))
    expect(clearDraftIfSent('scan-9')).toBe(true)
    expect(loadBrainDumpDraft()).toBeNull()
  })
})

describe('form checks agree with the server (B4)', () => {
  it('awards or publications alone count as content, like the server\'s hasResumeContent', () => {
    expect(manualHasContent({ awards: ['Dean\'s list'] })).toBe(true)
    expect(manualHasContent({ publications: ['A paper'] })).toBe(true)
    expect(manualHasContent({ name: 'J', awards: ['  '] })).toBe(false)
  })
  it('the editor hints at a missing name now that nothing fills it in silently', () => {
    expect(missingHints({ email: 'a@b.c', phone: '1', summary: 's' }).join(' ')).toMatch(/name/i)
    expect(missingHints({ name: 'J', email: 'a@b.c', phone: '1', summary: 's' })).toEqual([])
  })
})
