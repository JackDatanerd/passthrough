// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import api from '../src/lib/api'
import AdminPromptOutcomes from '../src/pages/admin/AdminPromptOutcomes'

vi.mock('../src/lib/api', () => ({ default: { get: vi.fn() } }))
vi.mock('../src/components/ui/Toast', () => ({ useToast: () => () => {} }))

const SCAN = '11111111-1111-4111-8111-111111111111'
const verdict = (over = {}) => ({ ask: false, reason: 'TOO_EARLY', at: '2026-10-20T00:00:00Z', ...over })
const result = (over = {}) => ({
  scanId: SCAN, days: 25, facts: { firstDeliveredAt: '2026-10-01T00:00:00Z', answer: null },
  schedule: { dashboardFrom: '2026-10-15T00:00:00Z', emailFrom: '2026-10-31T00:00:00Z', askUntil: '2027-01-29T00:00:00Z' },
  now_verdict: { dashboard: verdict(), email: verdict() },
  simulated: { dashboard: verdict({ ask: true, reason: 'ASK', at: null }), email: verdict({ ask: true, reason: 'SEND', at: null }) }, ...over,
})
beforeEach(() => {
  api.get.mockReset()
  api.get.mockImplementation(async (url) => {
    if (url === '/admin/prompt-outcomes') return { data: { data: { fix: [], letter: [], minResponses: 20 } } }
    if (url.startsWith('/admin/outcome-ask/')) return { data: { data: result() } }
    throw new Error('unexpected ' + url)
  })
})

describe('the interview-question simulator', () => {
  it('checks a scan now and N days ahead, and says in words why', async () => {
    render(<AdminPromptOutcomes />)
    fireEvent.change(await screen.findByLabelText('Scan id'), { target: { value: ` ${SCAN} ` } })
    fireEvent.change(screen.getByLabelText('Days ahead'), { target: { value: '25' } })
    fireEvent.click(screen.getByRole('button', { name: 'Check' }))
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(`/admin/outcome-ask/${SCAN}`, { params: { days: '25' } }))
    expect(await screen.findByText('Dashboard / My Story — now')).toBeInTheDocument()
    expect(screen.getAllByText('Too early — not yet due.')).toHaveLength(2)
    expect(screen.getByText('Dashboard — in 25 days')).toBeInTheDocument()
    expect(screen.getByText('The follow-up email will go out on the next hourly run.')).toBeInTheDocument()
  })
  it('shows the server\'s reason when the scan cannot be checked', async () => {
    api.get.mockImplementation(async (url) => {
      if (url === '/admin/prompt-outcomes') return { data: { data: { fix: [], letter: [], minResponses: 20 } } }
      throw { response: { data: { message: 'Scan not found.' } } }
    })
    render(<AdminPromptOutcomes />)
    fireEvent.change(await screen.findByLabelText('Scan id'), { target: { value: SCAN } })
    fireEvent.click(screen.getByRole('button', { name: 'Check' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Scan not found.')
  })
})
