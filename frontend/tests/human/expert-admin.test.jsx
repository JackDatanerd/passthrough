// Experts Phase 1: the expert site (its own token, locked lines, server errors) and the admin inbox.
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

const ex = vi.hoisted(() => ({ token: { get: vi.fn(() => null), set: vi.fn() }, login: vi.fn(), enrollStart: vi.fn(), mfa: vi.fn(), logout: vi.fn(), me: vi.fn(), jobs: vi.fn(), job: vi.fn(), save: vi.fn(), ask: vi.fn(), submit: vi.fn() }))
vi.mock('../../src/lib/expertApi', () => ({ expert: ex, EXPERT_TOKEN_KEY: 'pt_expert_token' }))
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }))
vi.mock('../../src/lib/api', () => ({ default: api, getErrorMessage: (e, d) => e?.response?.data?.message || d }))
import ExpertApp from '../../src/pages/expert/ExpertApp'
import AdminHumanOrders from '../../src/pages/admin/AdminHumanOrders'

beforeEach(() => { vi.clearAllMocks(); ex.token.get.mockReturnValue(null); window.sessionStorage.clear(); window.localStorage.clear() })

describe('expert sign-in', () => {
  it('password, then (first time) the key is shown once, then the code; the token goes to the expert store only', async () => {
    ex.login.mockResolvedValue({ stage: 'enroll', token: 'pending-tok' }); ex.enrollStart.mockResolvedValue({ secret: 'ABCDEFGH', otpauthUrl: 'otpauth://totp/x' }); ex.mfa.mockResolvedValue({ token: 'full-tok' }); ex.jobs.mockResolvedValue([])
    render(<ExpertApp />)
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ex@example.com' } }); fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } }); fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    expect(await screen.findByTestId('totp-secret')).toHaveTextContent('ABCDEFGH')
    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '123456' } }); fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
    await screen.findByText(/nothing is assigned to you/i)
    expect(ex.token.set).toHaveBeenCalledWith('pending-tok'); expect(ex.token.set).toHaveBeenCalledWith('full-tok')
    expect(window.localStorage.length).toBe(0)                  // the customer session's storage is never touched
  })
  it('a wrong code shows the server\'s plain message and stays on the page', async () => {
    ex.login.mockResolvedValue({ stage: 'mfa', token: 't' }); ex.mfa.mockRejectedValue({ response: { data: { message: 'Those details are not right.' } } })
    render(<ExpertApp />); fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.co' } }); fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } }); fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    fireEvent.change(await screen.findByLabelText('6-digit code'), { target: { value: '000000' } }); fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByText('Those details are not right.')).toBeInTheDocument()
  })
})

describe('expert workbench', () => {
  const JOB = { job: { id: 'j1', job_number: 'HJ-ABC234', state: 'in_progress', promised_deadline_at: '2026-11-03T10:00:00Z' }, brief: { targetRole: 'Senior PM', region: 'Africa', jobPosting: 'Hiring at [the company]' },
    document: { version: 3, body: { name: '[[lock:name]]', summary: 'Product manager. Reach me at [[c:1]].', experience: [{ company: 'Acme Ltd', title: 'PM', dates: '2019 - 2023', bullets: ['Grew users 40%.'] }], skills: ['SQL'] }, coverLetter: null },
    readOnly: ['name', 'experience.0.company', 'experience.0.title', 'experience.0.dates'], changes: [], questions: [], materials: [], askLimit: 3, canEdit: true }
  const open = async () => { ex.token.get.mockReturnValue('full-tok'); ex.jobs.mockResolvedValue([{ id: 'j1', jobNumber: 'HJ-ABC234', state: 'in_progress', tierLabel: '48-hour rewrite', payCents: 7000, dueAt: '2026-11-03T10:00:00Z' }]); ex.job.mockResolvedValue(JOB); render(<ExpertApp />); fireEvent.click(await screen.findByRole('button', { name: /HJ-ABC234/ })); await screen.findByLabelText('summary') }
  it('shows locked lines as locked (no input), protected details as such, and editable lines as editable; the employer is not in the brief', async () => {
    await open()
    expect(screen.queryByLabelText('name')).toBeNull(); expect(screen.queryByLabelText('experience.0.company')).toBeNull()
    expect(screen.getByText('Acme Ltd')).toBeInTheDocument(); expect(screen.getAllByText('protected detail').length).toBeGreaterThan(0)
    expect(screen.getByLabelText('summary')).toBeEnabled(); expect(screen.getByLabelText('experience.0.bullets.0')).toBeEnabled(); expect(screen.getByLabelText('skills.0')).toBeEnabled()
    expect(screen.getByText(/leave it exactly where it is/i)).toBeInTheDocument(); expect(screen.getByText(/Hiring at \[the company\]/)).toBeInTheDocument()
  })
  it('saves the edited document with the base version and shows the server\'s refusals (a locked change, a typed contact detail) without losing the edit', async () => {
    await open()
    fireEvent.change(screen.getByLabelText('summary'), { target: { value: 'Product leader. Mail me at a@b.com' } })
    ex.save.mockRejectedValueOnce({ response: { data: { message: 'Some of that cannot be saved.', errors: [{ path: 'summary', code: 'CONTACT_IN_TEXT' }] } } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(await screen.findByText(/summary: CONTACT_IN_TEXT/)).toBeInTheDocument(); expect(screen.getByLabelText('summary')).toHaveValue('Product leader. Mail me at a@b.com')
    expect(ex.save).toHaveBeenCalledWith('j1', expect.objectContaining({ baseVersion: 3 }))
    ex.save.mockResolvedValueOnce({ version: 4 }); fireEvent.change(screen.getByLabelText('summary'), { target: { value: 'Product leader.' } }); fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await screen.findByText('Saved.'); expect(ex.save).toHaveBeenLastCalledWith('j1', expect.objectContaining({ baseVersion: 3, body: expect.objectContaining({ summary: 'Product leader.' }) }))
  })
  it('lines can be added to and removed from a list of text lines; locked entries have no remove control', async () => {
    await open()
    fireEvent.click(screen.getAllByRole('button', { name: /add a line/i })[0]); expect(screen.getAllByRole('textbox').length).toBeGreaterThan(4)
    expect(screen.getAllByRole('button', { name: /remove this line/i }).length).toBeGreaterThan(0)
  })
  it('a job that is not theirs shows the access message, not the content', async () => {
    ex.token.get.mockReturnValue('full-tok'); ex.jobs.mockResolvedValue([{ id: 'j9', jobNumber: 'HJ-X', state: 'in_progress', tierLabel: 'x', payCents: 1 }]); ex.job.mockRejectedValue({ response: { status: 403, data: { message: 'You do not have access to this job.' } } })
    render(<ExpertApp />); fireEvent.click(await screen.findByRole('button', { name: /HJ-X/ })); expect(await screen.findByText(/do not have access/i)).toBeInTheDocument()
  })
  it('an expired session sends them back to sign-in', async () => {
    ex.token.get.mockReturnValue('old'); ex.jobs.mockRejectedValue({ response: { status: 401 } }); render(<ExpertApp />)
    expect(await screen.findByLabelText('Email')).toBeInTheDocument(); expect(ex.token.set).toHaveBeenCalledWith(null)
  })
})

describe('expert api client: the realms stay apart', () => {
  it('uses its own storage key and its own header; the customer\'s token key is never read', async () => {
    vi.resetModules(); vi.doUnmock('../../src/lib/expertApi')
    const seen = { handlers: [] }
    vi.doMock('axios', () => ({ default: { create: cfg => ({ defaults: cfg, interceptors: { request: { use: fn => seen.handlers.push(fn) } }, get: vi.fn(), post: vi.fn(), put: vi.fn() }) } }))
    const { expert, EXPERT_TOKEN_KEY } = await import('../../src/lib/expertApi')
    expect(EXPERT_TOKEN_KEY).toBe('pt_expert_token'); expect(EXPERT_TOKEN_KEY).not.toBe('token')
    window.localStorage.setItem('token', 'MAIN-APP-TOKEN'); expert.token.set('EXPERT-TOKEN')
    expect(window.sessionStorage.getItem('pt_expert_token')).toBe('EXPERT-TOKEN'); expect(window.localStorage.getItem('pt_expert_token')).toBeNull()
    const cfg = seen.handlers[0]({ headers: {} }); expect(cfg.headers.Authorization).toBe('Bearer EXPERT-TOKEN')
    expert.token.set(null); expect(seen.handlers[0]({ headers: {} }).headers.Authorization).toBeUndefined()
    vi.doUnmock('axios')
  })
})

describe('admin inbox', () => {
  const ORDERS = { orders: [{ id: 'j1', jobNumber: 'HJ-ABC234', state: 'offered', tier: 'forty_eight_hour', coverLetter: false, priceCents: 11900, payCents: 7000, customer: 'c@x.y', expert: null, paymentStatus: 'SUCCESS', dueAt: '2026-11-03T10:00:00Z', overdue: false }], counts: { offered: 1 }, capacity: { cap: 15, paid: 1 } }
  const DETAIL = { job: { id: 'j1', job_number: 'HJ-ABC234', state: 'offered', tier: 'forty_eight_hour', price_cents: 11900, expert_pay_cents: 7000, add_cover_letter: false, brief: { targetRole: 'PM' }, revision_count: 0, learning_consent: false }, customer: { email: 'c@x.y' }, payment: { status: 'SUCCESS' }, expert: null, events: [], questions: [], materials: [], deliveries: [], activeMinutes: 0 }
  const EXPERTS = { experts: [{ id: 'e1', name: 'Ann K.', email: 'a@x.co', status: 'active', enabled: true, twoFactor: true, agreementSigned: true, openJobs: 0, availableCents: 0, onHoldCents: 0, paidCents: 0 }, { id: 'e2', name: 'Bob L.', enabled: false, twoFactor: false, agreementSigned: false, openJobs: 0, availableCents: 0, onHoldCents: 0, paidCents: 0 }] }
  const wire = () => api.get.mockImplementation(async url => ({ data: { success: true, data: url.includes('/orders/j1') ? DETAIL : url.includes('/orders') ? ORDERS : url.includes('/experts') ? EXPERTS : {} } }))
  it('lists orders with the capacity line, opens one, and assigns only an expert who is on, has two-factor and a signed agreement', async () => {
    wire(); api.post.mockResolvedValue({ data: { success: true } }); render(<AdminHumanOrders />)
    expect(await screen.findByText(/1 of 15 paid orders/)).toBeInTheDocument()
    fireEvent.click(await screen.findByText('HJ-ABC234'))
    const dialog = await screen.findByRole('dialog', { name: /HJ-ABC234/ })
    const select = within(dialog).getByLabelText('Assign to'); const names = [...select.querySelectorAll('option')].map(o => o.textContent)
    expect(names.join('|')).toContain('Ann K.'); expect(names.join('|')).not.toContain('Bob L.')
    fireEvent.change(select, { target: { value: 'e1' } }); fireEvent.click(within(dialog).getByRole('button', { name: /^assign$/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/human/orders/j1/assign', { expertId: 'e1' }))
  })
  it('filters by state through the API', async () => {
    wire(); render(<AdminHumanOrders />); await screen.findByText('HJ-ABC234')
    fireEvent.change(screen.getByLabelText('Filter by state'), { target: { value: 'in_review' } })
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/admin/human/orders?state=in_review'))
  })
  it('the experts tab creates an account and shows the temporary password once', async () => {
    wire(); api.post.mockResolvedValue({ data: { success: true, data: { temporaryPassword: 'Abcd1234Efgh5678' } } }); render(<AdminHumanOrders />)
    fireEvent.click(screen.getByRole('tab', { name: /experts/i })); await screen.findByText('Ann K.')
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@x.co' } }); fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Cy' } }); fireEvent.change(screen.getByLabelText('Initial'), { target: { value: 'D' } })
    fireEvent.click(screen.getByRole('button', { name: /create expert/i }))
    expect(await screen.findByText(/Abcd1234Efgh5678/)).toBeInTheDocument(); expect(screen.getByText(/OFF until you switch it on/i)).toBeInTheDocument()
  })
})
