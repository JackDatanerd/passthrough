// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import api from '../../src/lib/api'
import SavedProfileEditor from '../../src/components/account/SavedProfileEditor'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), put: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))

// Profile & Dashboard round 12 (B4): the editor reports whether it holds unsaved edits, so Settings can ask
// before an action closes it.
const RESUME = { name: 'Jane Doe', summary: 'Ops lead.', skills: ['SQL'] }
beforeEach(() => { api.get.mockReset(); api.put.mockReset(); api.get.mockResolvedValue({ data: { data: { resumeData: RESUME } } }) })

describe('SavedProfileEditor reports unsaved edits', () => {
  it('false when loaded, true once something is typed, false again when put back', async () => {
    const user = userEvent.setup(); const onDirtyChange = vi.fn()
    render(<SavedProfileEditor onSaved={vi.fn()} onClose={vi.fn()} onDirtyChange={onDirtyChange} />)
    const name = await screen.findByLabelText('Name')
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
    await user.type(name, 'x')
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    await user.type(name, '{Backspace}')
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })
  it('is cleared when the editor goes away, so a closed editor never blocks anything', async () => {
    const user = userEvent.setup(); const onDirtyChange = vi.fn()
    const { unmount } = render(<SavedProfileEditor onSaved={vi.fn()} onClose={vi.fn()} onDirtyChange={onDirtyChange} />)
    await user.type(await screen.findByLabelText('Name'), 'x')
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    unmount()
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })
  it('the prop is optional', async () => {
    render(<SavedProfileEditor onSaved={vi.fn()} onClose={vi.fn()} />)
    expect(await screen.findByLabelText('Name')).toHaveValue('Jane Doe')
  })
})
