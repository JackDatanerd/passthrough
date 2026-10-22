// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
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

const LONG = Array.from({ length: 90 }, (_, i) => `sentence${i}`).join(' ')
const story = (over = {}) => ({
  scanId: 's1', roleCategory: 'marketing', outcome: 'INTERVIEW', interviewCount: 2, interviewAfterDays: 9, status: 'APPROVED',
  displayName: 'Amara O.', quote: 'Forty applications, then this.', text: LONG, showCredential: true,
  answeredAt: '2026-09-02T00:00:00Z', updatedAt: '2026-09-03T00:00:00Z', ...over,
})
function wire(stories) {
  api.get.mockImplementation(async url => {
    if (url === '/outcomes/mine') return { data: { data: { stories } } }
    if (url === '/outcomes/pending') return { data: { data: { pending: [], stories: [] } } }
    throw new Error('unexpected ' + url)
  })
}
beforeEach(() => { api.get.mockReset(); api.put.mockReset(); api.delete.mockReset() })

describe('My Story — preview by default', () => {
  it('a long story is a preview until the applicant clicks to read it all', async () => {
    const user = userEvent.setup()
    wire([story()])
    render(<MemoryRouter><MyStory /></MemoryRouter>)
    const list = await screen.findByRole('list', { name: 'Your stories' })
    expect(within(list).queryByText(/sentence89/)).toBeNull()
    await user.click(within(list).getByRole('button', { name: 'Read full story' }))
    expect(within(list).getByText(/sentence89/)).toBeInTheDocument()
  })

  it('the headline, status and the Edit / Take it down actions are all there without opening it', async () => {
    wire([story()])
    render(<MemoryRouter><MyStory /></MemoryRouter>)
    const list = await screen.findByRole('list', { name: 'Your stories' })
    expect(within(list).getByText('“Forty applications, then this.”')).toBeInTheDocument()
    expect(within(list).getByText('Published')).toBeInTheDocument()
    expect(within(list).getByRole('button', { name: 'Edit story' })).toBeEnabled()
    expect(within(list).getByRole('button', { name: 'Take it down' })).toBeEnabled()
  })

  it('editing always shows the whole text (a person must see everything they are changing)', async () => {
    const user = userEvent.setup()
    wire([story()])
    render(<MemoryRouter><MyStory /></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: 'Edit story' }))
    expect(screen.getByLabelText('Your story')).toHaveValue(LONG)
  })
})
