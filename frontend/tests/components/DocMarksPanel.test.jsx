// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// a plain function behind the mock (a vi.fn that rejects is reported by vitest as an unhandled rejection even when the caller handles it)
let patchImpl = async () => ({})
const calls = []
const patch = { mockReset() { calls.length = 0; patchImpl = async () => ({}) }, mockResolvedValue(v) { patchImpl = async () => v }, mockFailWith(e) { patchImpl = async () => { throw e } } }
vi.mock('../../src/lib/api', () => ({ default: { patch: (...a) => { calls.push(a); return patchImpl(...a) } }, getErrorMessage: (e, d) => e?.message || d }))

import DocMarksPanel from '../../src/components/scan/DocMarksPanel'
import VerifiedMark from '../../src/components/layout/VerifiedMark'
import { normalizeMarks, marksEqual, markOptions, MARK_KEYS } from '../../src/lib/docMarks'

beforeEach(() => patch.mockReset())

describe('docMarks helpers', () => {
  it('missing or partial marks mean on; only false turns one off', () => {
    expect(normalizeMarks(null)).toEqual({ header: true, colophon: true, footer: true })
    expect(normalizeMarks({ footer: false })).toEqual({ header: true, colophon: true, footer: false })
    expect(marksEqual({ header: true }, { header: true, colophon: true, footer: true })).toBe(true)
    expect(MARK_KEYS).toEqual(['header', 'colophon', 'footer'])
  })
  it('the header option names what the page says', () => {
    expect(markOptions(true)[0].label).toMatch(/Verified badge/)
    expect(markOptions(false)[0].label).toMatch(/Scan report badge/)
  })
})

describe('DocMarksPanel', () => {
  const scan = { id: 's1', docMarks: null }
  it('starts with all three ticked and nothing to apply', () => {
    render(<DocMarksPanel scan={scan} verified />)
    expect(screen.getAllByRole('checkbox')).toHaveLength(3)
    screen.getAllByRole('checkbox').forEach(c => expect(c).toBeChecked())
    expect(screen.getByRole('button', { name: /apply to my files/i })).toBeDisabled()
  })
  it('unticking one enables Apply, sends all three flags, then refetches', async () => {
    patch.mockResolvedValue({})
    const onChanged = vi.fn().mockResolvedValue()
    render(<DocMarksPanel scan={scan} verified onChanged={onChanged} />)
    fireEvent.click(screen.getAllByRole('checkbox')[2])
    fireEvent.click(screen.getByRole('button', { name: /apply to my files/i }))
    await waitFor(() => expect(calls).toEqual([['/scan/s1/doc-marks', { header: true, colophon: true, footer: false }]]))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })
  it('warns when everything is off, and shows a failure without claiming success', async () => {
    patch.mockFailWith(new Error('boom'))
    render(<DocMarksPanel scan={scan} verified />)
    screen.getAllByRole('checkbox').forEach(c => fireEvent.click(c))
    expect(screen.getByText(/no mention of Passthrough/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /apply to my files/i }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('boom'))
    expect(screen.queryByText(/Done\./)).toBeNull()
  })
})

describe('VerifiedMark', () => {
  it('draws the gold check only when verified', () => {
    const { container, rerender } = render(<VerifiedMark verified />)
    expect(container.innerHTML).toContain('#FFE27A')
    rerender(<VerifiedMark verified={false} />)
    expect(container.innerHTML).not.toContain('#FFE27A')
    expect(container.innerHTML).toContain('#6B7280')
  })
  it('is decorative, and uses the compact cut when small', () => {
    const { container } = render(<VerifiedMark verified size={20} />)
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(container.innerHTML).toContain('M9.5 6.5v4')
  })
})
