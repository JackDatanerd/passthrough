// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import api from '../../src/lib/api'
import MyStory from '../../src/pages/dashboard/MyStory'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), defaults: { baseURL: '/api' } },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
vi.mock('../../src/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, logout: () => {} }) }))
vi.mock('../../src/components/layout/DashboardLayout', () => ({ default: ({ children }) => <div>{children}</div> }))

const answer = { scanId: 's1', outcome: 'INTERVIEW', interviewCount: 1, interviewAfterDays: 5, storyStatus: 'APPROVED', jobTitle: 'Nurse', roleCategory: 'healthcare', fixTier: 'FIX', deliveredAt: '2026-08-01T00:00:00Z', answeredAt: '2026-08-20T00:00:00Z', updatedAt: '2026-08-20T00:00:00Z' }
beforeEach(() => { api.get.mockReset(); api.put.mockReset(); api.put.mockResolvedValue({ data: { data: { storyStatus: 'NONE' } } }) })

describe('My Story — answers', () => {
  it('shows the answers already given, and re-reads the stories when one is changed (a story can end with it)', async () => {
    const user = userEvent.setup()
    let mineCalls = 0
    api.get.mockImplementation(async url => {
      if (url === '/outcomes/mine') { mineCalls++; return { data: { data: { stories: [] } } } }
      if (url === '/outcomes/pending') return { data: { data: { pending: [], answers: [answer], stories: [] } } }
      throw new Error('unexpected ' + url)
    })
    render(<MemoryRouter><MyStory /></MemoryRouter>)
    expect(await screen.findByText('You told us: Yes, I got an interview')).toBeInTheDocument()
    await waitFor(() => expect(mineCalls).toBe(1))
    await user.click(screen.getByRole('button', { name: 'Change my answer' }))
    await user.click(screen.getByRole('button', { name: 'Not yet' }))
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/outcomes', { scanId: 's1', outcome: 'NO_INTERVIEW' }))
    await waitFor(() => expect(mineCalls).toBe(2))
  })
})
