// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import api from '../../src/lib/api'
import SavedProfileEditor from '../../src/components/account/SavedProfileEditor'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), put: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))

// Profile & Dashboard round 7: an edit is made against a specific version of the saved profile.
const V1 = { name: 'Jane Doe', skills: ['SQL'] }
const V2 = { name: 'New Scan Person', skills: ['Go'] }
beforeEach(() => { api.get.mockReset(); api.put.mockReset() })

describe('SavedProfileEditor — version-checked saves', () => {
  it('sends back the version it loaded', async () => {
    const user = userEvent.setup()
    api.get.mockResolvedValue({ data: { data: { resumeData: V1, version: 'S1|' } } })
    api.put.mockResolvedValue({ data: { success: true } })
    render(<SavedProfileEditor onSaved={vi.fn()} onClose={vi.fn()} />)
    await screen.findByLabelText('Name')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(api.put.mock.calls[0][1]).toMatchObject({ resumeData: V1, version: 'S1|' })
  })
  it('an older server that sends no version still works (no version is sent)', async () => {
    const user = userEvent.setup()
    api.get.mockResolvedValue({ data: { data: { resumeData: V1 } } })
    api.put.mockResolvedValue({ data: { success: true } })
    render(<SavedProfileEditor onSaved={vi.fn()} onClose={vi.fn()} />)
    await screen.findByLabelText('Name')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect('version' in api.put.mock.calls[0][1]).toBe(false)
  })
  it('on 409 PROFILE_CHANGED: says so, stays open, offers to reload instead of saving again; reloading shows the current profile and saves against ITS version', async () => {
    const user = userEvent.setup(); const onSaved = vi.fn(), onClose = vi.fn()
    api.get.mockResolvedValueOnce({ data: { data: { resumeData: V1, version: 'S1|' } } })
      .mockResolvedValueOnce({ data: { data: { resumeData: V2, version: 'S2|' } } })
    api.put.mockRejectedValueOnce({ response: { status: 409, data: { code: 'PROFILE_CHANGED', message: 'Your saved profile changed since you opened it.' } } })
      .mockResolvedValueOnce({ data: { success: true } })
    render(<SavedProfileEditor onSaved={onSaved} onClose={onClose} />)
    await user.type(await screen.findByLabelText('Name'), ' Jr')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText(/changed since you opened it/)).toBeInTheDocument()
    expect(onSaved).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()      // a second save would only conflict again
    await user.click(screen.getByRole('button', { name: 'Reload the current profile' }))
    expect(await screen.findByLabelText('Name')).toHaveValue('New Scan Person')    // the profile as it is NOW; the stale edit is gone
    expect(screen.queryByText(/changed since you opened it/)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(api.put.mock.calls[1][1].version).toBe('S2|')
  })
  it('any other save failure keeps the normal Save button (a retry can succeed)', async () => {
    const user = userEvent.setup()
    api.get.mockResolvedValue({ data: { data: { resumeData: V1, version: 'S1|' } } })
    api.put.mockRejectedValue({ response: { status: 500, data: { message: 'Server hiccup.' } } })
    render(<SavedProfileEditor onSaved={vi.fn()} onClose={vi.fn()} />)
    await screen.findByLabelText('Name')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText('Server hiccup.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Reload the current profile' })).toBeNull()
  })
})
