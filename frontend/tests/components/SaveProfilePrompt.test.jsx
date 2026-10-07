// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import api from '../../src/lib/api'
import SaveProfilePrompt from '../../src/components/scan/SaveProfilePrompt'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))

// Profile & Dashboard round 6: saving a scan's profile REPLACES the saved one — including
// corrections typed into the Settings editor, which now takes an explicit yes.
const profile = (over = {}) => ({ data: { data: { hasSavedProfile: true, savedAt: '2026-09-01T10:00:00Z', editedAt: null, sourceScanId: 'other', ...over } } })
const EDITED = '2026-09-20T10:00:00Z'
beforeEach(() => { api.get.mockReset(); api.post.mockReset() })

describe('SaveProfilePrompt — hand edits are not silently replaced', () => {
  it('no saved profile: saves straight away, with no confirmation and no replaceEdited', async () => {
    api.get.mockResolvedValue({ data: { data: { hasSavedProfile: false } } })
    api.post.mockResolvedValue({ data: { success: true } })
    render(<SaveProfilePrompt scanId="s1" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Save profile' }))
    expect(api.post).toHaveBeenCalledWith('/profile/save', { scanId: 's1' })
    expect(await screen.findByText(/Profile saved/)).toBeInTheDocument()
  })
  it('a saved profile that was never hand-edited is replaced without a dialog (as before)', async () => {
    api.get.mockResolvedValue(profile())
    api.post.mockResolvedValue({ data: { success: true } })
    render(<SaveProfilePrompt scanId="s1" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Replace saved profile' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.post).toHaveBeenCalledWith('/profile/save', { scanId: 's1' })
  })
  it('a hand-edited profile: the copy says so, and the click asks first — nothing is sent yet', async () => {
    api.get.mockResolvedValue(profile({ editedAt: EDITED }))
    render(<SaveProfilePrompt scanId="s1" />)
    expect(await screen.findByText(/corrections you made by hand/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Replace saved profile' }))
    const dlg = within(await screen.findByRole('dialog'))
    expect(dlg.getByText(/those corrections are lost/)).toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()
  })
  it('"Keep my edits" sends nothing; "Replace it" sends replaceEdited: true', async () => {
    api.get.mockResolvedValue(profile({ editedAt: EDITED }))
    api.post.mockResolvedValue({ data: { success: true } })
    render(<SaveProfilePrompt scanId="s1" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Replace saved profile' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Keep my edits' }))
    expect(api.post).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Replace saved profile' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Replace it' }))
    expect(api.post).toHaveBeenCalledWith('/profile/save', { scanId: 's1', replaceEdited: true })
    expect(await screen.findByText(/Profile saved/)).toBeInTheDocument()
  })
  it('edited in ANOTHER tab after this page loaded: the server\'s 409 PROFILE_EDITED opens the same question instead of an error', async () => {
    api.get.mockResolvedValue(profile())   // this page thinks it was never edited
    api.post.mockRejectedValueOnce({ response: { status: 409, data: { code: 'PROFILE_EDITED', message: 'x' } } })
    render(<SaveProfilePrompt scanId="s1" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Replace saved profile' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.queryByText('x')).toBeNull()
    api.post.mockResolvedValueOnce({ data: { success: true } })
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Replace it' }))
    expect(api.post).toHaveBeenLastCalledWith('/profile/save', { scanId: 's1', replaceEdited: true })
  })
  it('any other failure still shows its message', async () => {
    api.get.mockResolvedValue(profile())
    api.post.mockRejectedValue({ response: { status: 400, data: { message: 'This scan did not finish.' } } })
    render(<SaveProfilePrompt scanId="s1" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Replace saved profile' }))
    expect(await screen.findByText('This scan did not finish.')).toBeInTheDocument()
  })
})
