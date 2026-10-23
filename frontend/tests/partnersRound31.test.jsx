// @vitest-environment jsdom
// Section 4 round 31 (frontend): the admin code lookup's state filter and personal-codes switch actually drive the request.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../src/lib/api'
import PartnersLookupPanel from '../src/pages/admin/AdminPartnersLookup'

vi.mock('../src/lib/api', async () => {
  const { getErrorMessage } = await vi.importActual('../src/lib/errors')
  return { default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() }, getErrorMessage }
})
vi.mock('../src/components/ui/Toast', () => ({ useToast: () => vi.fn() }))

beforeEach(() => { cleanup(); vi.clearAllMocks() })
afterEach(cleanup)

const row = (over = {}) => ({ id: 'c1', code: 'COACH', partnerId: 'p1', partnerName: 'Kim', partnerEmail: 'k@x.co', personal: false, active: true, clicks: 1, usesSoFar: 0, usageLimit: null, expiresAt: null, ...over })
const codeCalls = () => api.get.mock.calls.filter(c => c[0] === '/partners/codes').map(c => c[1].params)

describe('code lookup filters', () => {
  it('sends active and personal only when chosen, and resets to the first page', async () => {
    api.get.mockResolvedValue({ data: { data: [row()], total: 1 } })
    render(<MemoryRouter><PartnersLookupPanel /></MemoryRouter>)
    fireEvent.click(screen.getByText(/Find a code/))
    await waitFor(() => expect(codeCalls().length).toBeGreaterThan(0))
    expect(codeCalls().at(-1)).toMatchObject({ active: undefined, limit: 25, offset: 0 })
    expect(codeCalls().at(-1).personal).toBeUndefined()

    fireEvent.change(screen.getByTestId('code-state-filter'), { target: { value: 'false' } })
    await waitFor(() => expect(codeCalls().at(-1).active).toBe('false'))

    fireEvent.click(screen.getByLabelText('Personal welcome codes only'))
    await waitFor(() => expect(codeCalls().at(-1)).toMatchObject({ personal: 'true', active: 'false', offset: 0 }))
  })
  it('shows a personal code as a personal code, not as a link to a partner page', async () => {
    api.get.mockResolvedValue({ data: { data: [row({ code: 'FN-ABCDE', personal: true, partnerName: 'Passthrough welcome codes (system)', partnerEmail: 'welcome-codes@system.invalid' })], total: 1 } })
    render(<MemoryRouter><PartnersLookupPanel /></MemoryRouter>)
    fireEvent.click(screen.getByText(/Find a code/))
    expect(await screen.findByTestId('personal-code')).toBeTruthy()
    expect(screen.queryByText('welcome-codes@system.invalid')).toBeNull()
    expect(screen.queryByRole('link', { name: /welcome codes/i })).toBeNull()
  })
})
