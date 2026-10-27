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

describe('an interview: one tap, then optional extras', () => {
  async function tapYes() {
    load({ pending: [pending()], stories: [] })
    render(<OutcomeCard />)
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, I got an interview' }))
    await screen.findByText(/Saved\. Great to hear/)
  }
  async function toStoryForm() {
    await tapYes()
    fireEvent.change(screen.getByLabelText('How many interviews?'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Days after you received the resume'), { target: { value: '6' } })
    fireEvent.click(screen.getByRole('button', { name: 'Share my story' }))
    await screen.findByLabelText('Your story')
  }

  it('"Yes" is saved the moment it is tapped, with nothing else filled in: the answer counts even if they walk away', async () => {
    await tapYes()
    expect(api.put).toHaveBeenCalledTimes(1)
    expect(api.put).toHaveBeenCalledWith('/outcomes', { scanId: SCAN, outcome: 'INTERVIEW' })
    expect(screen.getByRole('status')).toHaveTextContent(/Saved/)
  })

  it('the card stays on screen after the tap (the list is not reloaded until they finish), so the optional parts are still there', async () => {
    await tapYes()
    expect(api.get).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('How many interviews?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Share my story' })).toBeEnabled()
  })

  it('"Done" finishes: a thank-you, and the list is read again', async () => {
    await tapYes()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
    expect(api.put).toHaveBeenCalledTimes(1)                      // nothing more was sent
    expect(await screen.findByText(/genuinely helps/)).toBeInTheDocument()
  })

  it('the details are optional and separate: "Save details" is off until a field has a value, and blank fields are never sent as zeros', async () => {
    await tapYes()
    const save = screen.getByRole('button', { name: 'Save details' })
    expect(save).toBeDisabled()
    fireEvent.change(screen.getByLabelText('How many interviews?'), { target: { value: '3' } })
    expect(save).toBeEnabled()
    fireEvent.click(save)
    await waitFor(() => expect(api.put).toHaveBeenLastCalledWith('/outcomes', { scanId: SCAN, outcome: 'INTERVIEW', interviewCount: 3 }))
    expect(await screen.findByText('Details saved.')).toBeInTheDocument()
  })

  it('saves both details when both are given', async () => {
    await tapYes()
    fireEvent.change(screen.getByLabelText('How many interviews?'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Days after you received the resume'), { target: { value: '6' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }))
    await waitFor(() => expect(api.put).toHaveBeenLastCalledWith('/outcomes', { scanId: SCAN, outcome: 'INTERVIEW', interviewCount: 2, interviewAfterDays: 6 }))
  })

  it('if the tap cannot be saved, the server\'s reason is shown and the question stays open (nothing pretends it worked)', async () => {
    load({ pending: [pending()], stories: [] })
    api.put.mockRejectedValue({ response: { data: { message: 'You can report an outcome once your fixed resume has been delivered.' } } })
    render(<OutcomeCard />)
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, I got an interview' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/once your fixed resume has been delivered/)
    expect(screen.getByRole('button', { name: 'Yes, I got an interview' })).toBeEnabled()
    expect(screen.queryByText(/Saved\. Great to hear/)).toBeNull()
  })

  it('if only the optional details fail, the answer stays saved and the failure is shown', async () => {
    await tapYes()
    api.put.mockRejectedValueOnce({ response: { data: { message: 'Interview count must be between 1 and 99.' } } })
    fireEvent.change(screen.getByLabelText('How many interviews?'), { target: { value: '500' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/between 1 and 99/)
    expect(screen.getByRole('status')).toHaveTextContent(/Saved/)
    expect(screen.queryByText('Details saved.')).toBeNull()
  })

  it('the story is only offered, never forced: "Share my story" opens the form and "Not now" closes it without ending the flow', async () => {
    await tapYes()
    expect(screen.queryByLabelText('Your story')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Share my story' }))
    expect(await screen.findByLabelText('Your story')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByLabelText('Your story')).toBeNull()
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument()
    expect(api.put).toHaveBeenCalledTimes(1)
  })

  it('Submit stays disabled until the consent box is ticked; the story is sent with the details, consent, name, headline, text and the credential choice', async () => {
    await toStoryForm()
    const submit = screen.getByRole('button', { name: 'Submit story' })
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Name to show'), { target: { value: 'Amara O.' } })
    fireEvent.change(screen.getByLabelText('One-sentence headline'), { target: { value: 'Forty applications, zero replies — then this.' } })
    fireEvent.change(screen.getByLabelText('Your story'), { target: { value: 'I applied for two months with no replies. After the fix I heard back from the first role.' } })
    fireEvent.click(screen.getByLabelText(/Link my Verified credential/))
    expect(submit).toBeDisabled()   // still no consent
    fireEvent.click(screen.getByLabelText(/happy for Passthrough to publish/))
    expect(submit).toBeEnabled()
    load({ pending: [], stories: [] })   // once answered, the server no longer lists this scan as pending
    fireEvent.click(submit)
    await waitFor(() => expect(api.put).toHaveBeenLastCalledWith('/outcomes', {
      scanId: SCAN, outcome: 'INTERVIEW', interviewCount: 2, interviewAfterDays: 6,
      story: { consent: true, displayName: 'Amara O.', quote: 'Forty applications, zero replies — then this.', text: 'I applied for two months with no replies. After the fix I heard back from the first role.', showCredential: true },
    }))
    expect(await screen.findByRole('status')).toHaveTextContent(/not public until we approve/)
  })

  it('surfaces a story validation message from the server (e.g. links are not allowed)', async () => {
    await toStoryForm()
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

describe('an answer is never final', () => {
  const answer = (over = {}) => ({ scanId: SCAN, outcome: 'NO_INTERVIEW', interviewCount: null, interviewAfterDays: null, storyStatus: 'NONE', jobTitle: 'Product Manager', roleCategory: 'product_management', fixTier: 'FIX', deliveredAt: '2026-08-01T10:00:00Z', answeredAt: '2026-08-20T10:00:00Z', updatedAt: '2026-08-20T10:00:00Z', ...over })

  it('"still applying" comes back as its own question, worded as one', async () => {
    load({ pending: [pending({ reask: true })], answers: [], stories: [] })
    render(<OutcomeCard />)
    expect(await screen.findByText('You told us you were still applying. Any news?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Still applying' })).toBeEnabled()   // it can be snoozed again
  })
  it('names a credential-only delivery as a credential, not a fixed resume', async () => {
    load({ pending: [pending({ fixTier: 'BADGE' })], answers: [], stories: [] })
    render(<OutcomeCard />)
    expect(await screen.findByText('Did your credential lead to an interview?')).toBeInTheDocument()
    expect(screen.getByText(/Verified credential delivered/)).toBeInTheDocument()
  })
  it('lists nothing extra on the dashboard, but shows every answer given (changeable) where asked to', async () => {
    load({ pending: [], answers: [answer()], stories: [] })
    const { container, unmount } = render(<OutcomeCard />)
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
    unmount()
    render(<OutcomeCard showAnswers />)
    expect(await screen.findByText('You told us: Not yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change my answer' })).toBeEnabled()
  })
  it('changing "not yet" to "yes" sends INTERVIEW for that scan, offers the details, and tells the page to re-read', async () => {
    load({ pending: [], answers: [answer()], stories: [] })
    const onAnswered = vi.fn()
    render(<OutcomeCard showAnswers onAnswered={onAnswered} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Change my answer' }))
    expect(screen.queryByRole('button', { name: 'Not yet' })).toBeNull()                // the current answer is not offered again
    fireEvent.click(screen.getByRole('button', { name: 'Yes, I got an interview' }))
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/outcomes', { scanId: SCAN, outcome: 'INTERVIEW' }))
    expect(await screen.findByText('How many interviews?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(onAnswered).toHaveBeenCalled())
  })
  it('warns that moving away from "yes" takes a shared story down', async () => {
    load({ pending: [], answers: [answer({ outcome: 'INTERVIEW', storyStatus: 'APPROVED' })], stories: [] })
    render(<OutcomeCard showAnswers />)
    fireEvent.click(await screen.findByRole('button', { name: 'Change my answer' }))
    expect(screen.getByText(/takes the story you shared down/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Yes, I got an interview' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Still applying' }))
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/outcomes', { scanId: SCAN, outcome: 'STILL_APPLYING' }))
  })
})

describe('reporting an interview, a "not yet" re-ask, and a locked answer', () => {
  const report = (over = {}) => ({ scanId: SCAN, jobTitle: 'Product Manager', roleCategory: 'product_management', fixTier: 'FIX', deliveredAt: '2026-10-05T10:00:00Z', ...over })

  it('a "not yet" that comes back says so', async () => {
    load({ pending: [pending({ reask: true, previous: 'NO_INTERVIEW' })], answers: [], reportable: [], stories: [] })
    render(<OutcomeCard />)
    expect(await screen.findByText('You told us “not yet”. Any news?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Not yet' })).toBeEnabled()
  })
  it('My Story offers "I got an interview" on a fix that is not being asked about; only "yes" is offered, and it sends INTERVIEW', async () => {
    load({ pending: [], answers: [], reportable: [report()], stories: [] })
    render(<OutcomeCard showAnswers />)
    expect(await screen.findByText('Got an interview already?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'I got an interview' }))
    expect(screen.queryByRole('button', { name: 'Not yet' })).toBeNull()               // "not yet" at day 3 would be a meaningless answer
    expect(screen.queryByRole('button', { name: 'Still applying' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Yes, I got an interview' }))
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/outcomes', { scanId: SCAN, outcome: 'INTERVIEW' }))
  })
  it('the dashboard does not show the report list, only My Story does', async () => {
    load({ pending: [], answers: [], reportable: [report()], stories: [] })
    const { container } = render(<OutcomeCard />)
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
  it('a refunded purchase\'s answer is shown but cannot be changed, and says why', async () => {
    load({ pending: [], answers: [{ scanId: SCAN, outcome: 'NO_INTERVIEW', storyStatus: 'NONE', jobTitle: 'PM', roleCategory: 'product_management', fixTier: 'FIX', deliveredAt: '2026-08-01T10:00:00Z', locked: true }], reportable: [], stories: [] })
    render(<OutcomeCard showAnswers />)
    expect(await screen.findByText('You told us: Not yet')).toBeInTheDocument()
    expect(screen.getByText(/refunded or is under dispute/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Change my answer' })).toBeNull()
  })
})
