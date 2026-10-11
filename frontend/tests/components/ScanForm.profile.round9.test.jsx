// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../../src/lib/api'
import ScanForm from '../../src/components/scan/ScanForm'

// Profile & Dashboard round 9: /?mode=savedProfile&profile=<id> opens the saved-profile tab with THAT profile picked.
vi.mock('../../src/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))
vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
vi.mock('../../src/components/ui/FileUpload', () => ({ default: () => null }))

const extras = [{ id: 'p1', label: 'Product roles' }, { id: 'p2', label: 'Design roles' }]
function renderAt(path, hasSavedProfile = true) {
  api.get.mockReset()
  api.get.mockResolvedValue({ data: { data: { hasSavedProfile, extraProfiles: extras } } })
  render(<MemoryRouter initialEntries={[path]}><ScanForm /></MemoryRouter>)
}
beforeEach(() => localStorage.clear())

describe('ScanForm — ?profile= deep link', () => {
  it('picks the named additional profile', async () => {
    renderAt('/?mode=savedProfile&profile=p2')
    const select = await screen.findByLabelText('Profile to use')
    await waitFor(() => expect(select.value).toBe('p2'))
  })
  it('an id that is not one of the account\'s profiles is ignored (main profile stays selected)', async () => {
    renderAt('/?mode=savedProfile&profile=zzz')
    const select = await screen.findByLabelText('Profile to use')
    expect(select.value).toBe('')
  })
  it('works when there is no main profile at all', async () => {
    renderAt('/?mode=savedProfile&profile=p2', false)
    const select = await screen.findByLabelText('Profile to use')
    await waitFor(() => expect(select.value).toBe('p2'))
  })
})
