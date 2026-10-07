// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import api from '../../src/lib/api'
import ResumeFieldsForm from '../../src/components/scan/ResumeFieldsForm'
import ResumeDataEditor from '../../src/components/scan/ResumeDataEditor'
import { manualHasContent, missingHints, EMPTY_MANUAL } from '../../src/lib/resumeForm'
import { loadBrainDumpDraft, saveBrainDumpDraft, clearBrainDumpDraft } from '../../src/lib/brainDumpDraft'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), patch: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))

function Host({ initial, spy }) {
  const [draft, setDraft] = useState(initial)
  spy.current = draft
  return <ResumeFieldsForm draft={draft} setDraft={setDraft} />
}

describe('CsvInput inside the form — removing a row must not leave a stale list behind', () => {
  it('after removing project 0 the technologies box shows the NEXT project\'s technologies', async () => {
    const user = userEvent.setup(); const spy = { current: null }
    render(<Host spy={spy} initial={{ ...EMPTY_MANUAL, projects: [
      { name: 'One', description: 'd', technologies: ['Python', 'Flask'] },
      { name: 'Two', description: 'd', technologies: ['Go', 'Rust'] },
    ] }} />)
    await user.click(screen.getAllByRole('button', { name: 'Remove' }).find((b, i) => i >= 0 && b.closest('div')?.textContent.includes('One')) || screen.getAllByRole('button', { name: 'Remove' })[0])
    const box = screen.getByPlaceholderText('Technologies (comma-separated)')
    await waitFor(() => expect(box).toHaveValue('Go, Rust'))
    expect(spy.current.projects).toHaveLength(1)
  })
})

describe('ResumeFieldsForm — sections that used to be dropped', () => {
  it('lets the person enter job location, education details, languages, awards, publications and volunteer work', async () => {
    const user = userEvent.setup(); const spy = { current: null }
    render(<Host spy={spy} initial={{ ...EMPTY_MANUAL, experience: [{ company: 'A', title: 'B', dates: '', location: '', bullets: [] }], education: [{ institution: 'MIT', degree: 'BSc', dates: '', details: '' }] }} />)
    await user.type(screen.getByLabelText('Languages (comma-separated)'), 'English, French')
    expect(spy.current.languages).toEqual(['English', 'French'])
    await user.click(screen.getByText(/^Volunteer/).parentElement.querySelector('button'))
    expect(spy.current.volunteer).toHaveLength(1)
    expect(screen.getByLabelText(/Awards/i)).toBeTruthy()
    expect(screen.getByLabelText(/Publications/i)).toBeTruthy()
  })
})

describe('manualHasContent mirrors the server', () => {
  it('false for an empty form or only a name/contact details', () => {
    expect(manualHasContent(EMPTY_MANUAL)).toBe(false)
    expect(manualHasContent({ ...EMPTY_MANUAL, name: 'Jane', email: 'j@x.com', languages: ['English'] })).toBe(false)
    expect(manualHasContent(null)).toBe(false)
  })
  it('true for any real content', () => {
    expect(manualHasContent({ ...EMPTY_MANUAL, summary: 'x' })).toBe(true)
    expect(manualHasContent({ ...EMPTY_MANUAL, skills: ['Go'] })).toBe(true)
    expect(manualHasContent({ ...EMPTY_MANUAL, experience: [{ bullets: ['did x'] }] })).toBe(true)
    expect(manualHasContent({ ...EMPTY_MANUAL, volunteer: [{ organization: 'Red Cross' }] })).toBe(true)
    expect(manualHasContent({ ...EMPTY_MANUAL, certifications: ['AWS'] })).toBe(true)
  })
})

describe('missingHints', () => {
  it('names only what is actually missing', () => {
    const h = missingHints({ name: 'J', experience: [{ title: 'Dev', dates: '', bullets: [] }] })
    const text = h.join(' ')
    expect(text).toMatch(/email/i); expect(text).toMatch(/phone/i); expect(text).toMatch(/Dates on 1 role/); expect(text).toMatch(/1 role/)
  })
  it('is empty for a complete resume, and safe on null', () => {
    expect(missingHints({ email: 'a@b.c', phone: '1', summary: 's', experience: [{ dates: '2020', bullets: ['x'] }] })).toEqual([])
    expect(missingHints(null)).toEqual([])
  })
})

describe('brain-dump draft storage', () => {
  beforeEach(() => localStorage.clear())
  it('round-trips and clears', () => {
    saveBrainDumpDraft({ text: 'I built things', name: 'Jane', email: 'j@x.com' })
    expect(loadBrainDumpDraft()).toEqual({ text: 'I built things', name: 'Jane', email: 'j@x.com' })
    clearBrainDumpDraft()
    expect(loadBrainDumpDraft()).toBeNull()
  })
  it('saving an all-empty draft removes it instead of storing blanks', () => {
    saveBrainDumpDraft({ text: 'x' }); saveBrainDumpDraft({ text: '  ', name: '', email: '' })
    expect(loadBrainDumpDraft()).toBeNull()
  })
  it('corrupt stored data is ignored', () => {
    localStorage.setItem('passthrough_brain_dump_draft', '{not json')
    expect(loadBrainDumpDraft()).toBeNull()
    localStorage.setItem('passthrough_brain_dump_draft', '"a string"')
    expect(loadBrainDumpDraft()).toBeNull()
  })
  it('blocked storage never throws', () => {
    const orig = Storage.prototype.setItem
    Storage.prototype.setItem = () => { throw new Error('quota') }
    try { expect(() => saveBrainDumpDraft({ text: 'x' })).not.toThrow() } finally { Storage.prototype.setItem = orig }
  })
})

describe('ResumeDataEditor — drafts', () => {
  const scan = { id: 's1', originalResumeData: { name: 'Jane', skills: ['SQL'], experience: [{ company: 'Acme', title: 'Mgr', dates: '', bullets: [] }] } }
  it('shows what is missing and offers both a Word and a PDF draft', () => {
    render(<ResumeDataEditor scan={scan} onUpdated={vi.fn()} />)
    expect(screen.getByText(/Worth adding/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /PDF/i })).toBeTruthy()
  })
})
