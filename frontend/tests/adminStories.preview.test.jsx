// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import api from '../src/lib/api'
import AdminStories from '../src/pages/admin/AdminStories'

// A long story shows as a preview, and approving publishes ALL of it, so it cannot be approved until its full text has been opened.
const toast = vi.fn()
vi.mock('../src/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn() }, getErrorMessage: (e, f) => e?.response?.data?.message || f }))
vi.mock('../src/components/ui/Toast', () => ({ useToast: () => toast }))

const LONG = Array.from({ length: 90 }, (_, i) => `sentence${i}`).join(' ')
const story = (over = {}) => ({
  scanId: 's1', status: 'PENDING', roleCategory: 'sales', outcome: 'INTERVIEW', interviewCount: 1, interviewAfterDays: 4,
  displayName: 'Amara O.', quote: 'Zero replies, then this.', text: LONG, showCredential: false, credentialLive: false,
  scoreBefore: 44, scoreAfter: 90, answeredAt: '2026-09-02T10:00:00Z', ...over,
})
const list = stories => ({ data: { data: { stories, total: stories.length, page: 1, pageSize: 25 } } })
beforeEach(() => { api.get.mockReset(); api.post.mockReset(); toast.mockReset() })

describe('AdminStories — preview by default', () => {
  it('shows a long story as a preview, with the headline in full', async () => {
    api.get.mockResolvedValue(list([story()]))
    render(<AdminStories />)
    expect(await screen.findByText('“Zero replies, then this.”')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Read full story' })).toBeInTheDocument()
    expect(screen.queryByText(/sentence89/)).toBeNull()
  })

  it('cannot approve a long story until its full text is opened, and says why', async () => {
    api.get.mockResolvedValue(list([story()]))
    render(<AdminStories />)
    const approve = await screen.findByRole('button', { name: 'Approve' })
    expect(approve).toBeDisabled()
    expect(screen.getByTestId('read-to-approve')).toHaveTextContent(/Open the full story to approve it/)
    fireEvent.click(approve)
    expect(api.post).not.toHaveBeenCalled()
  })

  it('opening the full text unlocks Approve, which then works', async () => {
    api.get.mockResolvedValueOnce(list([story()])).mockResolvedValueOnce(list([]))
    api.post.mockResolvedValue({ data: { success: true } })
    render(<AdminStories />)
    fireEvent.click(await screen.findByRole('button', { name: 'Read full story' }))
    expect(screen.getByText(/sentence89/)).toBeInTheDocument()
    expect(screen.queryByTestId('read-to-approve')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/stories/s1/moderate', { action: 'approve' }))
  })

  it('collapsing it again does not lock Approve: reading is what counts', async () => {
    api.get.mockResolvedValue(list([story()]))
    render(<AdminStories />)
    fireEvent.click(await screen.findByRole('button', { name: 'Read full story' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()
  })

  it('a short story needs no extra step: Approve is available straight away', async () => {
    api.get.mockResolvedValue(list([story({ text: 'A short story.' })]))
    render(<AdminStories />)
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Read full story' })).toBeNull()
  })

  it('rejecting never needs a read: an unread long story can be rejected at once', async () => {
    api.get.mockResolvedValue(list([story()]))
    api.post.mockResolvedValue({ data: {} })
    render(<AdminStories />)
    const reject = await screen.findByRole('button', { name: 'Reject' })
    expect(reject).toBeEnabled()
    fireEvent.click(reject)
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/stories/s1/moderate', { action: 'reject' }))
  })

  it('a story its author edits after it was read counts as unread again (the reload shows new words)', async () => {
    api.get.mockResolvedValueOnce(list([story()]))
    api.post.mockRejectedValue({ response: { data: { message: 'This story changed while you were reviewing it. Reload and review it again.' } } })
    api.get.mockResolvedValueOnce(list([story({ text: LONG + ' and a sentence added afterwards' })]))
    render(<AdminStories />)
    fireEvent.click(await screen.findByRole('button', { name: 'Read full story' }))
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled())
    expect(screen.getByTestId('read-to-approve')).toBeInTheDocument()
  })

  it('an already-published story shows no read-to-approve prompt (there is nothing to approve)', async () => {
    api.get.mockResolvedValue(list([story({ status: 'APPROVED' })]))
    render(<AdminStories />)
    await screen.findByText('Amara O.')
    expect(screen.queryByTestId('read-to-approve')).toBeNull()
    expect(screen.getByRole('button', { name: 'Take down' })).toBeEnabled()
  })
})
