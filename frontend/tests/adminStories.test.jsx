// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import api from '../src/lib/api'
import AdminStories from '../src/pages/admin/AdminStories'

const toast = vi.fn()
vi.mock('../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
vi.mock('../src/components/ui/Toast', () => ({ useToast: () => toast }))

const story = (over = {}) => ({
  scanId: 's1', status: 'PENDING', roleCategory: 'sales', outcome: 'INTERVIEW', interviewCount: 2, interviewAfterDays: 4,
  displayName: 'Amara O.', quote: 'Zero replies, then this.', text: 'The full story text.\n\nSecond paragraph.', showCredential: true, credentialLive: true,
  scoreBefore: 44, scoreAfter: 90, answeredAt: '2026-09-02T10:00:00Z', moderatedAt: null, ...over,
})
const list = (stories, total = stories.length) => ({ data: { data: { stories, total, page: 1, pageSize: 25 } } })
beforeEach(() => { api.get.mockReset(); api.post.mockReset(); toast.mockReset() })

describe('AdminStories', () => {
  it('lists pending stories by default with everything a reviewer needs to judge them', async () => {
    api.get.mockResolvedValue(list([story()]))
    render(<AdminStories />)
    expect(await screen.findByText('Amara O.')).toBeInTheDocument()
    expect(api.get).toHaveBeenCalledWith('/admin/stories', { params: { status: 'PENDING', page: 1, pageSize: 25 } })
    expect(screen.getByText(/The full story text/)).toBeInTheDocument()
    expect(screen.getByText('44 → 90')).toBeInTheDocument()
    expect(screen.getByText('Links live credential')).toBeInTheDocument()
    expect(screen.getByText('2 interviews')).toBeInTheDocument()
  })
  it('flags a credential link that was requested but is not live (revoked page)', async () => {
    api.get.mockResolvedValue(list([story({ credentialLive: false })]))
    render(<AdminStories />)
    expect(await screen.findByText(/Credential link requested — not live/)).toBeInTheDocument()
  })
  it('approving posts the action, confirms, and reloads the list', async () => {
    api.get.mockResolvedValueOnce(list([story()])).mockResolvedValueOnce(list([]))
    api.post.mockResolvedValue({ data: { success: true } })
    render(<AdminStories />)
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/stories/s1/moderate', { action: 'approve' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })))
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Nothing here.')).toBeInTheDocument()
  })
  it('a "changed while you were reviewing" refusal is shown and the list is reloaded so the new text is read', async () => {
    api.get.mockResolvedValue(list([story()]))
    api.post.mockRejectedValue({ response: { data: { message: 'This story changed while you were reviewing it. Reload and review it again.' } } })
    render(<AdminStories />)
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ message: expect.stringMatching(/changed while you were reviewing/), type: 'error' }))
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
  })
  it('a published story offers "Take down", not "Approve"', async () => {
    api.get.mockResolvedValue(list([story({ status: 'APPROVED' })]))
    render(<AdminStories />)
    await screen.findByText('Amara O.')
    api.get.mockClear()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    api.post.mockResolvedValue({ data: {} })
    fireEvent.click(screen.getByRole('button', { name: 'Take down' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/stories/s1/moderate', { action: 'reject' }))
  })
  it('switching the filter queries that status from page 1', async () => {
    api.get.mockResolvedValue(list([]))
    render(<AdminStories />)
    await screen.findByText('Nothing here.')
    fireEvent.change(screen.getByLabelText('Filter stories by status'), { target: { value: 'REJECTED' } })
    await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/admin/stories', { params: { status: 'REJECTED', page: 1, pageSize: 25 } }))
  })
  it('reports a load failure instead of an empty list that looks like "nothing to review"', async () => {
    api.get.mockRejectedValue(new Error('down'))
    render(<AdminStories />)
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ message: 'Failed to load stories.', type: 'error' }))
  })
})
