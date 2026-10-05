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

const RESUME = {
  name: 'Jane Doe', email: 'jane@x.com', summary: 'Ops lead.',
  experience: [{ company: 'Acme', title: 'Manager', dates: '2020 – Present', bullets: ['Ran ops'] }],
  skills: ['SQL', 'Excel'],
}
beforeEach(() => { api.get.mockReset(); api.put.mockReset() })

describe('SavedProfileEditor', () => {
  it('loads the saved resume into the shared field form', async () => {
    api.get.mockResolvedValue({ data: { data: { resumeData: RESUME } } })
    render(<SavedProfileEditor onSaved={vi.fn()} onClose={vi.fn()} />)
    expect(await screen.findByLabelText('Name')).toHaveValue('Jane Doe')
    expect(screen.getByPlaceholderText('Company')).toHaveValue('Acme')
    expect(screen.getByLabelText('Skills (comma-separated)')).toHaveValue('SQL, Excel')
    expect(api.get).toHaveBeenCalledWith('/profile/data')
  })
  it('saves the edited resume in place (PUT /profile), then reports and closes', async () => {
    const user = userEvent.setup(); const onSaved = vi.fn(), onClose = vi.fn()
    api.get.mockResolvedValue({ data: { data: { resumeData: RESUME } } })
    api.put.mockResolvedValue({ data: { success: true } })
    render(<SavedProfileEditor onSaved={onSaved} onClose={onClose} />)
    const name = await screen.findByLabelText('Name')
    await user.clear(name); await user.type(name, 'Jane Q Doe')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    const body = api.put.mock.calls[0][1]
    expect(api.put.mock.calls[0][0]).toBe('/profile')
    expect(body.resumeData.name).toBe('Jane Q Doe')
    expect(body.resumeData.experience[0].company).toBe('Acme')   // untouched sections survive
    expect(onSaved).toHaveBeenCalled()
  })
  it('a rejected save keeps the editor open with the server\'s reason, and the edits intact', async () => {
    const user = userEvent.setup(); const onClose = vi.fn()
    api.get.mockResolvedValue({ data: { data: { resumeData: RESUME } } })
    api.put.mockRejectedValue({ response: { status: 400, data: { message: 'Add at least one job, school, skill or a summary — an empty profile is not worth saving.' } } })
    render(<SavedProfileEditor onSaved={vi.fn()} onClose={onClose} />)
    const name = await screen.findByLabelText('Name')
    await user.clear(name); await user.type(name, 'Changed')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/empty profile/)
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Name')).toHaveValue('Changed')
    expect(screen.getByRole('button', { name: 'Save changes' })).not.toBeDisabled()
  })
  it('a failed load says so and offers Close; Cancel closes without saving', async () => {
    const user = userEvent.setup(); const onClose = vi.fn()
    api.get.mockRejectedValue({ response: { status: 404, data: { message: 'No saved profile.' } } })
    const { unmount } = render(<SavedProfileEditor onSaved={vi.fn()} onClose={onClose} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('No saved profile.')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
    unmount()
    api.get.mockResolvedValue({ data: { data: { resumeData: RESUME } } })
    const onClose2 = vi.fn()
    render(<SavedProfileEditor onSaved={vi.fn()} onClose={onClose2} />)
    await screen.findByLabelText('Name')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose2).toHaveBeenCalled()
    expect(api.put).not.toHaveBeenCalled()
  })
})
