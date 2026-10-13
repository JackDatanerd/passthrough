// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
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

const story = (over = {}) => ({
  scanId: 's1', roleCategory: 'marketing', outcome: 'INTERVIEW', interviewCount: 2, interviewAfterDays: 9, status: 'APPROVED',
  displayName: 'Amara O.', quote: 'Forty applications, then this.', text: 'I applied for two months with no replies.\nThen the fix.', showCredential: true,
  answeredAt: '2026-09-02T00:00:00Z', updatedAt: '2026-09-03T00:00:00Z', ...over,
})
function wire(stories, { pending = [] } = {}) {
  api.get.mockImplementation(async url => {
    if (url === '/outcomes/mine') return { data: { data: { stories } } }
    if (url === '/outcomes/pending') return { data: { data: { pending, stories: [] } } }
    throw new Error('unexpected ' + url)
  })
}
const renderPage = () => render(<MemoryRouter><MyStory /></MemoryRouter>)
beforeEach(() => { api.get.mockReset(); api.put.mockReset(); api.delete.mockReset() })

describe('My Story', () => {
  it('lists a story with its words, who it is shown as, the interview facts and where it stands', async () => {
    wire([story()])
    renderPage()
    const list = await screen.findByRole('list', { name: 'Your stories' })
    expect(within(list).getByText('“Forty applications, then this.”')).toBeInTheDocument()
    expect(within(list).getByText(/I applied for two months/)).toBeInTheDocument()
    expect(within(list).getByText(/Shown as Amara O\./)).toBeInTheDocument()
    expect(within(list).getByText('Published')).toBeInTheDocument()
    expect(within(list).getByText(/2 interviews · 9 days after the resume arrived/)).toBeInTheDocument()
    expect(within(list).getByText('Your Verified link is shown beside the story.')).toBeInTheDocument()
    expect(within(list).getByRole('link', { name: 'See it on the homepage' })).toHaveAttribute('href', '/#stories')
  })

  it('names each state plainly: in review, not published (and only a published one links to the homepage)', async () => {
    wire([story({ scanId: 'a', status: 'PENDING', showCredential: false }), story({ scanId: 'b', status: 'REJECTED' })])
    renderPage()
    expect(await screen.findByText('In review')).toBeInTheDocument()
    expect(screen.getByText('Not published')).toBeInTheDocument()
    expect(screen.getByText('Your Verified link is not shown.')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'See it on the homepage' })).toBeNull()
  })

  it('says so, and points back to the scans, when there are no stories', async () => {
    wire([])
    renderPage()
    expect(await screen.findByText('No stories yet.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to your scans' })).toHaveAttribute('href', '/dashboard')
  })

  it('a failed load shows an error with a retry, and the retry works', async () => {
    api.get.mockImplementation(async url => {
      if (url === '/outcomes/mine') throw { response: { data: { message: 'down' } } }
      return { data: { data: { pending: [], stories: [] } } }
    })
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('down')
    wire([story()])
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Published')).toBeInTheDocument()
  })

  it('takes a story down only after confirming, then re-reads the list', async () => {
    const user = userEvent.setup()
    wire([story()])
    api.delete.mockResolvedValue({ data: { success: true } })
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Take it down' }))
    expect(api.delete).not.toHaveBeenCalled()
    wire([])
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Take it down' }))
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/outcomes/s1/story'))
    expect(await screen.findByText('Your story has been taken down.')).toBeInTheDocument()
    expect(await screen.findByText('No stories yet.')).toBeInTheDocument()
  })

  it('a take-down that fails says so and keeps the story', async () => {
    const user = userEvent.setup()
    wire([story()])
    api.delete.mockRejectedValue({ response: { status: 500, data: { message: 'Nope' } } })
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Take it down' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Take it down' }))
    expect(await screen.findByText('Nope')).toBeInTheDocument()
    expect(screen.getByText('“Forty applications, then this.”')).toBeInTheDocument()
  })

  it('editing starts from what was written, re-sends the interview details, and warns that a published story goes back to review', async () => {
    const user = userEvent.setup()
    wire([story()])
    api.put.mockResolvedValue({ data: { data: { outcome: 'INTERVIEW', storyStatus: 'PENDING' } } })
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Edit story' }))
    expect(screen.getByText(/goes back to review and comes off the homepage/)).toBeInTheDocument()
    const headline = screen.getByLabelText('One-sentence headline')
    expect(headline).toHaveValue('Forty applications, then this.')
    expect(screen.getByLabelText('Name to show')).toHaveValue('Amara O.')
    expect(screen.getByLabelText(/Link my Verified credential/)).toBeChecked()
    await user.clear(headline)
    await user.type(headline, 'Two months of silence, then three replies.')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(api.put.mock.calls[0][0]).toBe('/outcomes')
    expect(api.put.mock.calls[0][1]).toMatchObject({
      scanId: 's1', outcome: 'INTERVIEW', interviewCount: 2, interviewAfterDays: 9,
      story: { consent: true, displayName: 'Amara O.', quote: 'Two months of silence, then three replies.', showCredential: true },
    })
    expect(await screen.findByText(/is with our team for review/)).toBeInTheDocument()
  })

  it('saving an approved story with no changes says it is still published', async () => {
    const user = userEvent.setup()
    wire([story()])
    api.put.mockResolvedValue({ data: { data: { outcome: 'INTERVIEW', storyStatus: 'APPROVED' } } })
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Edit story' }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText('Nothing changed, so your story is still published.')).toBeInTheDocument()
  })

  it('leaves out interview details that were never given instead of sending empty ones', async () => {
    const user = userEvent.setup()
    wire([story({ interviewCount: null, interviewAfterDays: null })])
    api.put.mockResolvedValue({ data: { data: { storyStatus: 'PENDING' } } })
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Edit story' }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(api.put.mock.calls[0][1]).not.toHaveProperty('interviewCount')
    expect(api.put.mock.calls[0][1]).not.toHaveProperty('interviewAfterDays')
  })

  it('shows the "how did it go" question when a fix is due for an answer, without repeating the story list', async () => {
    wire([story()], { pending: [{ scanId: 'p1', jobTitle: 'Data Analyst', roleCategory: null, deliveredAt: '2026-08-01T00:00:00Z' }] })
    renderPage()
    expect(await screen.findByText('Did it lead to an interview?')).toBeInTheDocument()
    expect(screen.getAllByText('“Forty applications, then this.”')).toHaveLength(1)
  })
})
