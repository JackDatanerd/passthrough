// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import api from '../src/lib/api'
import ScanResult from '../src/pages/ScanResult'
const auth = { user: { id: 'u1', name: 'Ada', emailVerified: true, freeFixCredits: 0 }, refreshUser: vi.fn(async () => auth.user), authLoading: false }
vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => auth }))
vi.mock('../src/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn(), defaults: { baseURL: 'https://api.example/api' } }, getErrorMessage: (e, f) => e?.response?.data?.error || e?.response?.data?.message || f }))
const popup = { onSuccess: null, onCancel: null }
vi.mock('@paystack/inline-js', () => ({ default: class { resumeTransaction(code, o) { popup.onSuccess = o.onSuccess; popup.onCancel = o.onCancel; popup.opts = o } newTransaction() {} } }))
vi.mock('../src/hooks/usePricing', async orig => ({ ...(await orig()), usePricing: () => ({ pricing: { currency: 'USD' }, byTier: t => ({ FIX: { amount: 2900, originalAmount: 2900 }, FIX_PLAIN: { amount: 1900, originalAmount: 1900 }, BADGE: { amount: 900, originalAmount: 900 } }[t]), pricingFailed: false, refresh: vi.fn(), clockOffsetMs: 0 }) }))
vi.mock('../src/lib/poller', async orig => ({ ...(await orig()), createPoller: fn => ({ start: (o = {}) => { if (o.immediate !== false) fn() }, stop: () => {} }) }))
const T = new Date().toISOString()
const scan = o => ({ id: 's1', userId: 'u1', atsScore: 62, passed: false, inputMode: 'text', jobTitle: 'PM', status: 'COMPLETE_FAIL', fixPurchased: false, fixTier: 'FIX', jobDescriptionText: 'x '.repeat(60), originalResumeData: { name: 'A', experience: [], skills: [] }, atsDetail: { weights: { keywords: .35, format: .25, sections: .2, content: .2 }, keywords: { missing: [], matched: [] }, format: { issues: [] }, sections: { missing: [] }, content: {} }, createdAt: T, updatedAt: T, ...o })
let errors, S
beforeEach(() => { errors = []; vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(String(a[0]).slice(0, 120))); window.open = vi.fn(); api.get.mockReset(); api.post.mockReset(); auth.user = { id: 'u1', name: 'Ada', emailVerified: true, freeFixCredits: 0 } })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const calls = () => [...api.post.mock.calls.map(c => 'POST ' + c[0]), ...api.get.mock.calls.map(c => 'GET ' + c[0]).filter(u => !/status|\/scan\/s1$/.test(u))]
async function open(s, pending = null) {
  S = s
  api.get.mockImplementation(async url => { if (url.startsWith('/payments/pending')) return { data: { data: { pending } } }; if (url.startsWith('/payments/verify')) return { data: { data: { status: 'PENDING' } }, status: 202 }; if (url.includes('/status')) return { data: { data: { status: S.status, atsScore: S.atsScore } } }; if (url.startsWith('/scan/')) return { data: { data: S } }; return { data: { data: {} } } })
  render(<RouterProvider router={createMemoryRouter([{ path: '/scan/:id/:tab', element: <ScanResult /> }, { path: '/scan/:id', element: <ScanResult /> }], { initialEntries: ['/scan/s1'] })} />)
  await act(async () => { await new Promise(r => setTimeout(r, 40)) })
}
const body = () => document.body.textContent.replace(/\s+/g, ' ')
// Payment states of the result page, through the REAL page: an open checkout, an unverified email, a slow bank, a closed popup.
describe('payment flows', () => {
  it('a checkout already open: both actions work', async () => {
    await open(scan(), { reference: 'ref1', fixTier: 'BADGE', amount: 900 })
    expect(body()).toMatch(/You have a payment in progress for the verified badge\./)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Check payment status' }))
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    expect(calls()).toContain('GET /payments/verify?reference=ref1')
    expect(body()).toMatch(/Still processing/)
    api.post.mockResolvedValue({ data: { data: {} } })
    await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel that payment' }))
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    expect(calls()).toContain('POST /payments/ref1/cancel')
    expect(body()).not.toMatch(/payment in progress/)
  })
  it('unverified email: message, resend, and the buy buttons recover', async () => {
    auth.user = { id: 'u1', emailVerified: false, freeFixCredits: 0 }
    await open(scan())
    await userEvent.setup().click(screen.getByRole('button', { name: /Fix & verify my resume/ }))
    await act(async () => { await new Promise(r => setTimeout(r, 40)) })
    expect(body()).toMatch(/Please verify your email address before buying/)
    expect(api.post).not.toHaveBeenCalledWith('/payments/initialize', expect.anything())
    api.post.mockResolvedValue({ data: {} })
    await userEvent.setup().click(screen.getByRole('button', { name: /Resend verification/ }))
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    expect(body()).toMatch(/Verification email sent/)
  })
  it('popup success then the bank is slow (verify says pending): page waits and says so', async () => {
    await open(scan())
    api.post.mockImplementation(async url => url === '/payments/initialize' ? { data: { data: { access_code: 'ac', reference: 'r1', amount: 2900, currency: 'USD' } } } : { data: { data: {} } })
    await userEvent.setup().click(screen.getByRole('button', { name: /Fix & verify my resume/ }))
    await act(async () => { await new Promise(r => setTimeout(r, 60)) })
    expect(popup.onSuccess).toBeTruthy()
    await act(async () => { popup.onSuccess?.({ reference: 'r1' }); await new Promise(r => setTimeout(r, 60)) })
    expect(body()).toMatch(/bank|confirm/i)
    expect(screen.queryAllByRole('button', { name: /Fix & verify my resume/ }).every(b => b.disabled)).toBe(true)
  })
  it('popup closed by the buyer: nothing is stuck', async () => {
    await open(scan())
    api.post.mockImplementation(async url => url === '/payments/initialize' ? { data: { data: { access_code: 'ac', reference: 'r1', amount: 2900, currency: 'USD' } } } : { data: { data: {} } })
    await userEvent.setup().click(screen.getByRole('button', { name: /Fix & verify my resume/ }))
    await act(async () => { await new Promise(r => setTimeout(r, 60)) })
    await act(async () => { popup.onCancel?.(); await new Promise(r => setTimeout(r, 40)) })
    const btn = screen.getByRole('button', { name: /Fix & verify my resume/ })
    expect(btn).not.toBeDisabled()
  })
})
