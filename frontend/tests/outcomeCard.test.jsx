// @vitest-environment jsdom
// The dashboard question behind the homepage's interview rate. The properties that matter: every answer is
// equally easy (no nudge toward the flattering one), a story needs a ticked consent box, errors are shown and
// never swallowed, and a card with nothing to ask renders nothing at all.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import api from '../src/lib/api'
import OutcomeCard from '../src/components/account/OutcomeCard'

vi.mock('../src/lib/api', () => ({
  default: { get: vi.fn(), put: vi.fn(), delete: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))

const SCAN = '11111111-1111-4111-8111-111111111111'
const pending = (over = {}) => ({ scanId: SCAN, jobTitle: 'Product Manager', roleCategory: 'product_management', scoreBefore: 48, scoreAfter: 88, deliveredAt: '2026-09-01T10:00:00Z', ...over })
const load = (data) => api.get.mockImplementation(async (url) => {
  if (url === '/outcomes/pending') return { data: { data } }
  throw new Error('unexpected ' + url)
})
beforeEach(() => { api.get.mockReset(); api.put.mockReset(); api.delete.mockReset(); api.put.mockResolvedValue({ data: { success: true } }) })

describe('visibility', () => {
  it('renders nothing when there is nothing to ask and no story to manage', async () => {
    load({ pending: [], stories: [] })
    const { container } = render(<OutcomeCard />)
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
  it('renders nothing (and no error banner) when the request fails — it is an extra, never a blocker', async () => {
    api.get.mockRejectedValue(new Error('down'))
    const { container } = render(<OutcomeCard />)
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})

describe('answering', () => {
  it('offers three equally easy answers, and says an honest "not yet" helps as much as a "yes"', async () => {
    load({ pending: [pending()], stories: [] })
    render(<OutcomeCard />)
    expect(await screen.findByText('Did it lead to an interview?')).toBeInTheDocument()
    for (const name of ['Yes, I got an interview', 'Not yet', 'Still applying']) expect(screen.getByRole('button', { name })).toBeEnabled()
    expect(screen.getByText(/honest .not yet. helps us as much as a .yes./i)).toBeInTheDocument()
  })
  it('"Not yet" saves NO_INTERVIEW straight away — no extra steps', async () => {
    load({ pending: [pending()], stories: [] })
    render(<OutcomeCard />)
    fireEvent.click(await screen.findByRole('button', { name: 'Not yet' }))
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/outcomes', { scanId: SCAN, outcome: 'NO_INTERVIEW' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/genuinely helps/)
  })
  it('"Still applying" saves STILL_APPLYING', async () => {
    load({ pending: [pending()], stories: [] })
    render(<OutcomeCard />)
    fireEvent.click(await screen.findByRole('button', { name: 'Still applying' }))
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/outcomes', { scanId: SCAN, outcome: 'STILL_APPLYING' }))
  })
  it('shows the server\'s reason when saving fails, and keeps the question open', async () => {
    load({ pending: [pending()], stories: [] })
    api.put.mockRejectedValue({ response: { data: { message: 'You can report an outcome once your fixed resume has been delivered.' } } })
    render(<OutcomeCard />)
    fireEvent.click(await screen.findByRole('button', { name: 'Not yet' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/once your fixed resume has been delivered/)
    expect(screen.getByRole('button', { name: 'Not yet' })).toBeEnabled()
  })
})

describe('an interview, and an optional story', () => {
  async function toStoryStep() {
    load({ pending: [pending()], stories: [] })
    render(<OutcomeCard />)
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, I got an interview' }))
    fireEvent.change(screen.getByLabelText('How many interviews?'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Days after you received the resume'), { target: { value: '6' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByText(/Would you share your story/)
  }
  it('saves the interview (with its details) BEFORE asking for a story — the answer counts even if they walk away', async () => {
    await toStoryStep()
    expect(api.put).toHaveBeenCalledTimes(1)
    expect(api.put).toHaveBeenCalledWith('/outcomes', { scanId: SCAN, outcome: 'INTERVIEW', interviewCount: 2, interviewAfterDays: 6 })
  })
  it('the details are optional: blank fields are not sent as zeros', async () => {
    load({ pending: [pending()], stories: [] })
    render(<OutcomeCard />)
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, I got an interview' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByText(/Would you share your story/)
    expect(api.put).toHaveBeenCalledWith('/outcomes', { scanId: SCAN, outcome: 'INTERVIEW' })
  })
  it('"Not now" ends the flow with no story request', async () => {
    await toStoryStep()
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/genuinely helps/)
    expect(api.put).toHaveBeenCalledTimes(1)
  })
  it('Submit stays disabled until the consent box is ticked; the story is sent with consent, name, headline, text and the credential choice', async () => {
    await toStoryStep()
    const submit = screen.getByRole('button', { name: 'Submit story' })
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Name to show'), { target: { value: 'Amara O.' } })
    fireEvent.change(screen.getByLabelText('One-sentence headline'), { target: { value: 'Forty applications, zero replies — then this.' } })
    fireEvent.change(screen.getByLabelText('Your story'), { target: { value: 'I applied for two months with no replies. After the fix I heard back from the first role.' } })
    fireEvent.click(screen.getByLabelText(/Link my Verified credential/))
    expect(submit).toBeDisabled()   // still no consent
    fireEvent.click(screen.getByLabelText(/happy for Passthrough to publish/))
    expect(submit).toBeEnabled()
    fireEvent.click(submit)
    await waitFor(() => expect(api.put).toHaveBeenLastCalledWith('/outcomes', {
      scanId: SCAN, outcome: 'INTERVIEW', interviewCount: 2, interviewAfterDays: 6,
      story: { consent: true, displayName: 'Amara O.', quote: 'Forty applications, zero replies — then this.', text: 'I applied for two months with no replies. After the fix I heard back from the first role.', showCredential: true },
    }))
    expect(await screen.findByRole('status')).toHaveTextContent(/not public until we approve/)
  })
  it('surfaces a story validation message from the server (e.g. links are not allowed)', async () => {
    await toStoryStep()
    api.put.mockRejectedValueOnce({ response: { data: { message: 'Please leave links and contact details out of your story.' } } })
    fireEvent.click(screen.getByLabelText(/happy for Passthrough to publish/))
    fireEvent.click(screen.getByRole('button', { name: 'Submit story' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/leave links and contact details out/)
  })
})

describe('managing a story that exists', () => {
  const stories = [{ scanId: SCAN, status: 'PENDING', displayName: 'Amara O.', quote: 'Zero replies, then this.' }]
  it('shows its review state and lets the author take it down', async () => {
    load({ pending: [], stories })
    api.delete.mockResolvedValue({ data: { success: true } })
    render(<OutcomeCard />)
    expect(await screen.findByText(/Waiting for review — it is not public yet/)).toBeInTheDocument()
    load({ pending: [], stories: [] })   // after withdrawing, the reload returns nothing
    fireEvent.click(screen.getByRole('button', { name: 'Take my story down' }))
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith(`/outcomes/${SCAN}/story`))
    expect(await screen.findByRole('status')).toHaveTextContent(/taken down/)
  })
  it('reports a failed take-down instead of pretending it worked', async () => {
    load({ pending: [], stories })
    api.delete.mockRejectedValue({ response: { data: { message: 'No story to withdraw.' } } })
    render(<OutcomeCard />)
    fireEvent.click(await screen.findByRole('button', { name: 'Take my story down' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/No story to withdraw/)
  })
})
