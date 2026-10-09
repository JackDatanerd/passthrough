// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import api from '../../src/lib/api'
import ResumeDataEditor from '../../src/components/scan/ResumeDataEditor'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), patch: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))

// The field form was extracted into ResumeFieldsForm (shared with the saved-profile editor):
// the scan-result editor must behave exactly as before.
const scan = { id: 's1', originalResumeData: {
  name: 'Jane', experience: [{ company: 'Acme', title: 'Mgr', dates: '2020', bullets: ['a'] }], education: [], skills: ['SQL'],
} }
beforeEach(() => { api.patch.mockReset() })

describe('ResumeDataEditor (after the field form was extracted)', () => {
  it('Review & edit shows the shared form; edits are sent to the scan\'s own endpoint and reported', async () => {
    const user = userEvent.setup(); const onUpdated = vi.fn()
    api.patch.mockResolvedValue({ data: { data: { atsScore: 91 } } })
    render(<ResumeDataEditor scan={scan} anonToken="tok" onUpdated={onUpdated} />)
    await user.click(screen.getByRole('button', { name: 'Review & edit' }))
    const name = screen.getByLabelText('Name')
    expect(name).toHaveValue('Jane')
    await user.clear(name); await user.type(name, 'Jane D')
    await user.click(screen.getAllByRole('button', { name: '+ Add' })[1])   // a new education row
    await user.click(screen.getByRole('button', { name: 'Save changes & rescore' }))
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith({ atsScore: 91 }))
    expect(api.patch.mock.calls[0][0]).toBe('/scan/s1/resume-data?token=tok')
    expect(api.patch.mock.calls[0][1].resumeData.name).toBe('Jane D')
  })
  it('Cancel leaves the stored data untouched and closes the form', async () => {
    const user = userEvent.setup()
    render(<ResumeDataEditor scan={scan} onUpdated={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Review & edit' }))
    await user.type(screen.getByLabelText('Name'), 'XYZ')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    // Edited text is not thrown away on a stray click: the form stays until the discard is confirmed.
    expect(screen.getByLabelText('Name')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.queryByLabelText('Name')).toBeNull()
    expect(api.patch).not.toHaveBeenCalled()
  })
})
