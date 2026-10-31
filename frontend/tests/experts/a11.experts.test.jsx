// @vitest-environment jsdom
// A11, expert site. These run the REAL api client (only the network adapter is stubbed), so the session-ended interceptor is exercised too.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Link } from 'react-router-dom'
import App from '../../src/experts/App'
import { SessionProvider } from '../../src/experts/session'
import { _http } from '../../src/experts/api'
import { parseDollars, formatDollars } from '../../src/experts/money'
import { routeTitle } from '../../src/experts/Layout'

let table, calls
const reply = (status, data) => ({ status, data })
const okd = data => reply(200, { success: true, data })
const authGone = () => reply(401, { success: false, message: 'Please sign in again.', code: 'AUTH' })
const ME = (roles = ['expert']) => okd({ id: 'x1', firstName: 'Ada', roles, totpEnabled: true })
beforeEach(() => {
  table = {}; calls = []
  _http.defaults.adapter = async config => {
    const key = `${config.method.toUpperCase()} ${config.url}`; calls.push({ key, config })
    const h = table[key]; if (!h) throw Object.assign(new Error('no stub for ' + key), { isAxiosError: true })
    const r = await h(config)
    if (r.status >= 400) throw Object.assign(new Error('http ' + r.status), { isAxiosError: true, config, response: { status: r.status, data: r.data, config, headers: {} } })
    return { data: r.data, status: r.status, statusText: 'OK', headers: {}, config }
  }
})
afterEach(() => { cleanup(); vi.useRealTimers() })
const count = key => calls.filter(c => c.key === key).length
const mount = (path, extra = null) => render(<MemoryRouter initialEntries={[path]}><SessionProvider><App />{extra}</SessionProvider></MemoryRouter>)

describe('money.js', () => {
  it('B4 reads digits with an optional dot and one or two decimals, and nothing else', () => {
    expect(parseDollars('10')).toBe(1000); expect(parseDollars('10.5')).toBe(1050); expect(parseDollars('10.50')).toBe(1050); expect(parseDollars(' $25 ')).toBe(2500); expect(parseDollars('0.29')).toBe(29); expect(parseDollars('1.1')).toBe(110)
    for (const bad of ['10,50', '1,000', '12abc', '1e3', '-5', '0', '0.00', '', '1.234', '$', 'ten', '1..5', '.5', '99999999']) expect(parseDollars(bad), bad).toBeNull()
    expect(formatDollars(1050)).toBe('$10.50'); expect(formatDollars(100000)).toBe('$1,000.00'); expect(formatDollars(5)).toBe('$0.05')
  })
})

describe('session ended by the server', () => {
  it('B3 a 401 AUTH on any screen returns to sign-in and says why', async () => {
    table['GET /expert-realm/me'] = async () => ME(); table['GET /expert-realm/desk'] = async () => authGone()
    mount('/desk')
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy(); expect(screen.getByText(/Your session ended/)).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Your desk' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull()
  })
  it('B3 a wrong password (401 without the AUTH code) is just a wrong password: no "session ended"', async () => {
    table['GET /expert-realm/me'] = async () => reply(401, { success: false, message: 'Please sign in again.', code: 'AUTH' })
    table['POST /expert-realm/auth/login'] = async () => reply(401, { success: false, message: 'Email or password is not correct.' })
    mount('/sign-in'); await userEvent.type(await screen.findByLabelText(/^Email/), 'a@b.co'); await userEvent.type(screen.getByLabelText(/^Password/), 'pw'); await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('Email or password is not correct.')).toBeTruthy(); expect(screen.queryByText(/Your session ended/)).toBeNull()
  })
  it('B3 a wrong second-factor code (401 BAD_CODE) keeps the person on the code screen', async () => {
    table['GET /expert-realm/me'] = async () => reply(401, { success: false, message: 'x', code: 'AUTH' })
    table['POST /expert-realm/auth/login'] = async () => okd({ stage: 'mfa' }); table['POST /expert-realm/auth/totp'] = async () => reply(401, { success: false, message: 'That code did not work.', code: 'BAD_CODE' })
    mount('/sign-in'); await userEvent.type(await screen.findByLabelText(/^Email/), 'a@b.co'); await userEvent.type(screen.getByLabelText(/^Password/), 'pw'); await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await userEvent.type(await screen.findByLabelText(/^6-digit code/), '123456'); await userEvent.click(screen.getByRole('button', { name: 'Verify' }))
    expect(await screen.findByText('That code did not work.')).toBeTruthy(); expect(screen.getByRole('heading', { name: 'Two-factor code' })).toBeTruthy()
  })
  it('B3 coming back to the tab after a while asks the server again, and a session that ended meanwhile goes to sign-in', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] }); let n = 0
    table['GET /expert-realm/me'] = async () => (++n === 1 ? ME() : authGone()); table['GET /expert-realm/desk'] = async () => okd({ jobs: [] })
    mount('/desk'); await screen.findByRole('heading', { name: 'Your desk' })
    fireEvent(document, new Event('visibilitychange')); await new Promise(r => setTimeout(r, 30)); expect(count('GET /expert-realm/me')).toBe(1)        // too soon: no extra call
    vi.setSystemTime(Date.now() + 120000); fireEvent(document, new Event('visibilitychange'))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy(); expect(count('GET /expert-realm/me')).toBe(2)
  })
})

describe('two-factor enrolment', () => {
  it('B10 the setup key is requested once, even when the screen is left and come back to (the server replaces the key on every request)', async () => {
    table['GET /expert-realm/me'] = async () => authGone(); table['POST /expert-realm/auth/login'] = async () => okd({ stage: 'enroll' }); table['POST /expert-realm/auth/totp/setup'] = async () => okd({ secret: 'SECRET-ONE', otpauthUrl: 'otpauth://x' })
    mount('/sign-in', <><Link to="/forgot-password">away</Link><Link to="/two-factor">back</Link></>)
    await userEvent.type(await screen.findByLabelText(/^Email/), 'a@b.co'); await userEvent.type(screen.getByLabelText(/^Password/), 'pw'); await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect((await screen.findByTestId('setup-secret')).textContent).toBe('SECRET-ONE')
    await userEvent.click(screen.getByText('away')); await screen.findByRole('heading', { name: 'Reset your password' })
    await userEvent.click(screen.getByText('back')); expect((await screen.findByTestId('setup-secret')).textContent).toBe('SECRET-ONE')
    expect(count('POST /expert-realm/auth/totp/setup')).toBe(1)
  })
  it('B10 two screens asking at once (a development double-render) share one request', async () => {
    let n = 0; let release
    table['GET /expert-realm/me'] = async () => authGone(); table['POST /expert-realm/auth/login'] = async () => okd({ stage: 'enroll' })
    table['POST /expert-realm/auth/totp/setup'] = () => new Promise(res => { n++; release = () => res(okd({ secret: 'S', otpauthUrl: 'o' })) })
    const { StrictMode } = await import('react')
    render(<StrictMode><MemoryRouter initialEntries={['/sign-in']}><SessionProvider><App /></SessionProvider></MemoryRouter></StrictMode>)
    await userEvent.type(await screen.findByLabelText(/^Email/), 'a@b.co'); await userEvent.type(screen.getByLabelText(/^Password/), 'pw'); await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByText(/Preparing your setup key/); await act(async () => { release() }); await screen.findByTestId('setup-secret'); expect(n).toBe(1)
  })
  it('B10 a failed setup request can be asked again (the screen is not stuck)', async () => {
    let n = 0
    table['GET /expert-realm/me'] = async () => authGone(); table['POST /expert-realm/auth/login'] = async () => okd({ stage: 'enroll' })
    table['POST /expert-realm/auth/totp/setup'] = async () => (++n === 1 ? reply(500, { success: false, message: 'Try again.' }) : okd({ secret: 'S2', otpauthUrl: 'o' }))
    mount('/sign-in', <><Link to="/forgot-password">away</Link><Link to="/two-factor">back</Link></>)
    await userEvent.type(await screen.findByLabelText(/^Email/), 'a@b.co'); await userEvent.type(screen.getByLabelText(/^Password/), 'pw'); await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByText('Try again.'); await userEvent.click(screen.getByText('away')); await screen.findByRole('heading', { name: 'Reset your password' }); await userEvent.click(screen.getByText('back'))
    expect((await screen.findByTestId('setup-secret')).textContent).toBe('S2')
  })
})

describe('admin console', () => {
  const JOB = okd({ job: { id: 'j1', jobNumber: 'HJ-1', state: 'delivered', tier: 'seven_day', version: 3, dueAt: null }, expert: null, clock: null, nextAction: null, timeline: [] })
  const setupRefund = () => { table['GET /expert-realm/me'] = async () => ME(['expert_admin']); table['GET /expert-admin/jobs/j1'] = async () => JOB; table['GET /expert-admin/experts'] = async () => okd({ experts: [] }); table['POST /expert-admin/jobs/j1/refund'] = async () => okd({}) }
  const openRefund = async () => { mount('/admin/jobs/j1'); await userEvent.click(await screen.findByRole('button', { name: 'Refund this order' })); await userEvent.type(await screen.findByLabelText(/^Reason/), 'customer asked for it') }
  it('B4 an amount typed as 10,50 (or 12abc, 1e3, 1,000) is refused and nothing is sent; the form says what it will do', async () => {
    setupRefund(); await openRefund(); const box = await screen.findByLabelText(/^Amount in dollars/)
    for (const bad of ['10,50', '12abc', '1e3', '1,000']) {
      await userEvent.clear(box); await userEvent.type(box, bad); expect(screen.getByTestId('refund-preview').textContent).toMatch(/not an amount/)
      await userEvent.click(screen.getByRole('button', { name: 'Refund' })); expect(await screen.findByText(/digits and a dot only/)).toBeTruthy(); expect(count('POST /expert-admin/jobs/j1/refund'), bad).toBe(0)
    }
    await userEvent.clear(box); expect(screen.getByTestId('refund-preview').textContent).toMatch(/Everything that is left/)
  })
  it('B4 10.50 is shown as $10.50 and sent as 1050 cents; an empty amount is the full refund', async () => {
    setupRefund(); await openRefund(); await userEvent.type(await screen.findByLabelText(/^Amount in dollars/), '10.50'); expect(screen.getByTestId('refund-preview').textContent).toBe('$10.50 will be refunded.')
    await userEvent.click(screen.getByRole('button', { name: 'Refund' })); await waitFor(() => expect(count('POST /expert-admin/jobs/j1/refund')).toBe(1))
    expect(JSON.parse(calls.find(c => c.key === 'POST /expert-admin/jobs/j1/refund').config.data)).toMatchObject({ amountCents: 1050, reason: 'customer asked for it' })
  })
  it('B9 the job board shows the rows of the filter that is selected, whatever order the answers arrive in; an old error goes when a load succeeds', async () => {
    let n = 0; const slow = {}
    table['GET /expert-realm/me'] = async () => ME(['expert_admin'])
    table['GET /expert-admin/board'] = config => { const state = (config.params || {}).state || ''; n++
      if (n === 1) return Promise.resolve(reply(500, { success: false, message: 'Boom.' }))
      return new Promise(res => { slow[state] = rows => res(okd({ jobs: rows })) }) }
    mount('/admin'); await screen.findByText('Boom.'); const sel = screen.getByLabelText(/State/)
    await userEvent.selectOptions(sel, 'open'); await userEvent.selectOptions(sel, 'claimed')
    await act(async () => { slow.claimed([{ id: 'c', jobNumber: 'CLAIMED-1', state: 'claimed', tier: 'x' }]) })
    await act(async () => { slow.open([{ id: 'o', jobNumber: 'OPEN-1', state: 'open', tier: 'x' }]) })
    expect(await screen.findByText('CLAIMED-1')).toBeTruthy(); expect(screen.queryByText('OPEN-1')).toBeNull(); expect(screen.queryByText('Boom.')).toBeNull()
  })
  it('B9 the audit filter waits for a pause in typing, then asks once with the whole text; the latest answer wins', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    table['GET /expert-realm/me'] = async () => ME(['expert_admin']); table['GET /expert-admin/audit'] = async config => okd({ entries: [{ id: (config.params || {}).action || 'all', created_at: null, actor_kind: 'a', action: (config.params || {}).action || 'ALL-ROWS', target_type: 't', detail: {} }], nextBefore: null })
    mount('/admin/audit'); const box = await screen.findByLabelText(/Filter by action/); await screen.findByText('ALL-ROWS')
    for (const v of ['m', 'mo', 'mon', 'money.refund']) fireEvent.change(box, { target: { value: v } })
    expect(count('GET /expert-admin/audit')).toBe(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    await waitFor(() => expect(count('GET /expert-admin/audit')).toBe(2)); expect(calls.filter(c => c.key === 'GET /expert-admin/audit')[1].config.params).toEqual({ action: 'money.refund' })
    expect(await screen.findByText('money.refund')).toBeTruthy()
  })
})

describe('titles', () => {
  it('G5 the tab title and the screen-reader announcement say where you are', async () => {
    expect(routeTitle('/desk')).toBe('Desk \u2014 Passthrough Experts'); expect(routeTitle('/admin')).toBe('Job board \u2014 Passthrough Experts'); expect(routeTitle('/admin/jobs/x')).toBe('Job \u2014 Passthrough Experts'); expect(routeTitle('/nope')).toBe('Passthrough Experts')
    table['GET /expert-realm/me'] = async () => ME(); table['GET /expert-realm/desk'] = async () => okd({ jobs: [] })
    mount('/desk'); await screen.findByRole('heading', { name: 'Your desk' }); expect(document.title).toBe('Desk \u2014 Passthrough Experts'); expect(screen.getByTestId('route-announcer').textContent).toBe('Desk \u2014 Passthrough Experts')
  })
})
