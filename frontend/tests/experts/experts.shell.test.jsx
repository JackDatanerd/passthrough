// @vitest-environment jsdom
// Experts Phase 2A: the expert site's shell: sign-in, two-factor, recovery codes, role gating, the empty Desk, sessions, the refund confirmation.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import fs from 'node:fs'
import path from 'node:path'

const { realm, admin } = vi.hoisted(() => {
  const f = names => Object.fromEntries(names.map(n => [n, vi.fn()]))
  return { realm: f(['login', 'totpSetup', 'totp', 'recover', 'me', 'logout', 'logoutAll', 'sessions', 'endSession', 'stepUp', 'changePassword', 'newRecoveryCodes', 'forgot', 'reset', 'desk']),
    admin: f(['board', 'job', 'assign', 'reassign', 'refund', 'experts', 'audit']) }
})
vi.mock('../../src/experts/api', () => ({ realm, admin, errorMessage: (e, f) => e?.response?.data?.message || f, errorCode: e => e?.response?.data?.code || null, onSessionEnded: () => () => {} }))
import App from '../../src/experts/App'
import { SessionProvider } from '../../src/experts/session'

const ME = (roles = ['expert']) => ({ id: 'x1', firstName: 'Ada', roles, totpEnabled: true, sessionExpiresAt: '2026-11-01T00:00:00Z', elevatedUntil: null })
const mount = (path = '/', meRoles) => {
  meRoles ? realm.me.mockResolvedValue(ME(meRoles)) : realm.me.mockRejectedValue({ response: { status: 401 } })
  return render(<MemoryRouter initialEntries={[path]}><SessionProvider><App /></SessionProvider></MemoryRouter>)
}
const err = (message, code) => ({ response: { data: { message, ...(code ? { code } : {}) } } })
let setItem
beforeEach(() => { Object.values(realm).forEach(f => f.mockReset()); Object.values(admin).forEach(f => f.mockReset()); setItem = vi.spyOn(Storage.prototype, 'setItem') })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('signed out', () => {
  it('every screen sends a signed-out visitor to sign in', async () => {
    for (const p of ['/desk', '/settings', '/admin', '/admin/experts', '/admin/audit', '/recovery-codes']) { const { unmount } = mount(p); expect(await screen.findByRole('heading', { name: 'Sign in' }), p).toBeTruthy(); unmount() }
  })
  it('sign-in sends the password once, clears it, moves to the second factor, and stores nothing in the browser', async () => {
    realm.login.mockResolvedValue({ stage: 'mfa' }); mount('/sign-in')
    await userEvent.type(await screen.findByLabelText(/^Email/), 'ada@example.com'); await userEvent.type(screen.getByLabelText(/^Password/), 'a long passphrase here'); await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(realm.login).toHaveBeenCalledWith('ada@example.com', 'a long passphrase here')); expect(await screen.findByRole('heading', { name: 'Two-factor code' })).toBeTruthy()
    expect(setItem).not.toHaveBeenCalled()
  })
  it('a wrong password shows the server\'s message and stays on the page', async () => {
    realm.login.mockRejectedValue(err('Email or password is not correct.')); mount('/sign-in')
    await userEvent.type(await screen.findByLabelText(/^Email/), 'a@b.co'); await userEvent.type(screen.getByLabelText(/^Password/), 'x'); await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('Email or password is not correct.')).toBeTruthy(); expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy()
  })
  it('the second-factor screen with no sign-in in progress goes back to sign in', async () => { mount('/two-factor'); expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy() })
  it('reset needs the token from the URL fragment, and says so without it', async () => {
    mount('/reset-password'); expect(await screen.findByText(/This link is not valid/)).toBeTruthy(); expect(screen.getByRole('button', { name: 'Set password' }).disabled).toBe(true)
  })
  it('asking for a reset link gives the same answer whatever the email', async () => {
    realm.forgot.mockRejectedValue(err('x')); mount('/forgot-password'); await userEvent.type(await screen.findByLabelText(/^Email/), 'who@example.com'); await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }))
    expect(await screen.findByText(/If that account exists/)).toBeTruthy()
  })
})

describe('first sign-in: setup key, code, recovery codes shown once', () => {
  it('enrolment shows the key, verifies the code, then lists the ten recovery codes once', async () => {
    realm.login.mockResolvedValue({ stage: 'enroll' }); realm.totpSetup.mockResolvedValue({ secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/x' })
    const codes = Array.from({ length: 10 }, (_, i) => `abcd${i}-efgh${i}`); realm.totp.mockResolvedValue({ stage: 'full', recoveryCodes: codes }); mount('/sign-in')
    await userEvent.type(await screen.findByLabelText(/^Email/), 'a@b.co'); await userEvent.type(screen.getByLabelText(/^Password/), 'pw'); await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect((await screen.findByTestId('setup-secret')).textContent).toBe('JBSWY3DPEHPK3PXP')
    realm.me.mockResolvedValue(ME()); await userEvent.type(screen.getByLabelText(/^6-digit code/), '123456'); await userEvent.click(screen.getByRole('button', { name: 'Verify' }))
    const list = await screen.findByTestId('recovery-codes'); expect(list.querySelectorAll('li')).toHaveLength(10); expect(setItem).not.toHaveBeenCalled()
  })
  it('a lost phone uses a recovery code and is told how many are left', async () => {
    realm.login.mockResolvedValue({ stage: 'mfa' }); realm.recover.mockResolvedValue({ stage: 'full', recoveryCodesLeft: 7 }); mount('/sign-in')
    await userEvent.type(await screen.findByLabelText(/^Email/), 'a@b.co'); await userEvent.type(screen.getByLabelText(/^Password/), 'pw'); await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await userEvent.click(await screen.findByRole('button', { name: /lost my phone/i })); realm.me.mockResolvedValue(ME())
    await userEvent.type(screen.getByLabelText(/^Recovery code/), 'abcde-fghjk'); await userEvent.click(screen.getByRole('button', { name: 'Verify' }))
    expect(await screen.findByText(/7 left/)).toBeTruthy()
  })
  it('a bad code shows the message and clears the field', async () => {
    realm.login.mockResolvedValue({ stage: 'mfa' }); realm.totp.mockRejectedValue(err('That code did not work.')); mount('/sign-in')
    await userEvent.type(await screen.findByLabelText(/^Email/), 'a@b.co'); await userEvent.type(screen.getByLabelText(/^Password/), 'pw'); await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await userEvent.type(await screen.findByLabelText(/^6-digit code/), '000000'); await userEvent.click(screen.getByRole('button', { name: 'Verify' }))
    expect(await screen.findByText('That code did not work.')).toBeTruthy(); expect(screen.getByLabelText(/^6-digit code/).value).toBe('')
  })
})

describe('signed in: roles decide what is shown', () => {
  it('an expert lands on an empty Desk and does not see console links or screens', async () => {
    realm.desk.mockResolvedValue([]); mount('/', ['expert'])
    expect(await screen.findByText(/Nothing on your desk/)).toBeTruthy()
    for (const name of ['Job board', 'Experts', 'Audit log']) expect(screen.queryByRole('link', { name })).toBeNull()
    cleanup(); mount('/admin', ['expert']); expect(await screen.findByText(/Nothing on your desk/)).toBeTruthy()
  })
  it('support sees the job board but not the directory or audit log', async () => {
    admin.board.mockResolvedValue([]); mount('/admin', ['expert_support'])
    expect(await screen.findByRole('heading', { name: 'Job board' })).toBeTruthy(); expect(screen.queryByRole('link', { name: 'Experts' })).toBeNull(); expect(screen.queryByRole('link', { name: 'Audit log' })).toBeNull()
    cleanup(); realm.desk.mockResolvedValue([]); mount('/admin/audit', ['expert_support']); expect(await screen.findByRole('heading', { name: 'Job board' })).toBeTruthy()
  })
  it('an admin sees every console link', async () => {
    admin.board.mockResolvedValue([]); mount('/admin', ['expert_admin']); await screen.findByRole('heading', { name: 'Job board' })
    for (const name of ['Job board', 'Experts', 'Audit log']) expect(screen.getByRole('link', { name })).toBeTruthy()
  })
})

describe('settings and sessions', () => {
  it('lists sessions, ends another one, and signs out everywhere', async () => {
    realm.sessions.mockResolvedValue([{ id: 's1', device: 'Phone', current: false, lastSeenAt: '2026-10-01T00:00:00Z' }, { id: 's2', device: 'Laptop', current: true, lastSeenAt: '2026-10-01T00:00:00Z' }])
    mount('/settings', ['expert']); await screen.findByText('Phone'); expect(screen.getByText('This device')).toBeTruthy()
    realm.endSession.mockResolvedValue(null); await userEvent.click(screen.getByRole('button', { name: 'End' })); await waitFor(() => expect(realm.endSession).toHaveBeenCalledWith('s1'))
    realm.logoutAll.mockResolvedValue(null); await userEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' })); await waitFor(() => expect(realm.logoutAll).toHaveBeenCalled())
  })
  it('new recovery codes ask for the password first when the server says so, then show ten codes', async () => {
    realm.sessions.mockResolvedValue([]); realm.newRecoveryCodes.mockRejectedValueOnce(err('Confirm your password to continue.', 'STEP_UP_REQUIRED')); mount('/settings', ['expert'])
    await userEvent.click(await screen.findByRole('button', { name: 'Make new recovery codes' })); const pw = await screen.findByLabelText(/^Confirm your password/)
    realm.stepUp.mockResolvedValue({}); realm.newRecoveryCodes.mockResolvedValueOnce({ recoveryCodes: Array.from({ length: 10 }, (_, i) => `c${i}`) })
    await userEvent.type(pw, 'my password'); await userEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect((await screen.findByTestId('new-recovery-codes')).querySelectorAll('li')).toHaveLength(10); expect(realm.stepUp).toHaveBeenCalledWith('my password')
  })
})

describe('the refund confirmation', () => {
  const job = { job: { id: 'j1', jobNumber: 'HJ-1', state: 'delivered', tier: 'forty_eight_hour', version: 4, dueAt: '2026-10-03T00:00:00Z' }, expert: { id: 'e1', firstName: 'Bo', initial: 'K' }, nextAction: null, clock: null, clockMatchesStored: true, timeline: [{ id: 1, kind: 'paid', actorKind: 'system', at: '2026-10-01T00:00:00Z', from: 'awaiting_payment', to: 'offered' }] }
  const open = async roles => { admin.job.mockResolvedValue(job); admin.experts.mockResolvedValue([]); mount('/admin/jobs/j1', roles); await userEvent.click(await screen.findByRole('button', { name: 'Refund this order' })) }
  it('states the consequence, needs a reason, and asks for the password only when the server requires it, reusing one request key', async () => {
    await open(['expert_admin']); expect(screen.getByText(/cannot be undone/)).toBeTruthy()
    const go = screen.getByRole('button', { name: 'Refund' }); expect(go.disabled).toBe(true)
    await userEvent.type(screen.getByLabelText(/Reason/), 'duplicate order'); expect(go.disabled).toBe(false)
    admin.refund.mockRejectedValueOnce(err('Confirm your password to continue.', 'STEP_UP_REQUIRED')); await userEvent.click(go)
    const pw = await screen.findByLabelText(/^Confirm your password to continue/); realm.stepUp.mockResolvedValue({}); admin.refund.mockResolvedValueOnce({ queued: true })
    await userEvent.type(pw, 'secret pass'); await userEvent.click(screen.getByRole('button', { name: 'Confirm and refund' }))
    await waitFor(() => expect(admin.refund).toHaveBeenCalledTimes(2)); expect(realm.stepUp).toHaveBeenCalledWith('secret pass')
    const [a, b] = admin.refund.mock.calls; expect(a[1].idemKey).toBeTruthy(); expect(a[1].idemKey).toBe(b[1].idemKey); expect(b[1].reason).toBe('duplicate order')
    expect(await screen.findByText(/Refund queued/)).toBeTruthy()
  })
  it('support never sees the refund button or the assign controls', async () => {
    admin.job.mockResolvedValue(job); mount('/admin/jobs/j1', ['expert_support']); await screen.findByText('Timeline')
    expect(screen.queryByRole('button', { name: 'Refund this order' })).toBeNull(); expect(screen.queryByText('Reassign')).toBeNull()
  })
  it('a typed amount is sent in cents', async () => {
    await open(['expert_admin']); await userEvent.type(screen.getByLabelText(/Amount/), '12.50'); await userEvent.type(screen.getByLabelText(/Reason/), 'partial goodwill'); admin.refund.mockResolvedValue({ queued: true })
    await userEvent.click(screen.getByRole('button', { name: 'Refund' })); await waitFor(() => expect(admin.refund.mock.calls[0][1].amountCents).toBe(1250))
  })
})

describe('the expert site keeps the credential out of its own code', () => {
  const dir = path.resolve(__dirname, '../../src/experts')
  const files = fs.readdirSync(dir, { recursive: true }).filter(f => /\.(jsx?|css)$/.test(f)).map(f => [f, fs.readFileSync(path.join(dir, f), 'utf8')])
  it('never touches browser storage, cookies, an Authorization header, the customer API client or the API base URL variable', () => {
    expect(files.length).toBeGreaterThanOrEqual(10)
    for (const [f, src] of files) for (const bad of [/localStorage/, /sessionStorage/, /document\.cookie/, /Authorization/i, /lib\/api['"]/, /VITE_API_URL/, /indexedDB/]) expect(bad.test(src), `${f} ${bad}`).toBe(false)
  })
})
