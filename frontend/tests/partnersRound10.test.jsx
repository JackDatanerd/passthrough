// @vitest-environment jsdom
// Section 4 round 10 (frontend): the account-kept attribution, the payout statement, and the partner's own link reset.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../src/lib/api'

vi.mock('../src/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn() } }))
vi.mock('../src/components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../src/components/layout/Footer', () => ({ default: () => null }))

const KEY = 'passthrough_referral_code'
const DAY = 24 * 3600 * 1000

describe('useReferralCapture — account attribution', () => {
  beforeEach(() => { vi.resetModules(); api.post.mockReset(); api.post.mockResolvedValue({ data: {} }); localStorage.clear(); window.history.pushState({}, '', '/') })

  it('restores the account code on a device that has none, as source "account" with its original timestamp', async () => {
    const mod = await import('../src/hooks/useReferralCapture')
    const at = Date.now() - 3 * DAY
    mod.restoreReferralFromAccount({ referredByCode: 'COACH20', referredAt: new Date(at).toISOString() })
    expect(mod.getStoredReferralCode()).toBe('COACH20')
    expect(mod.getStoredReferralSource()).toBe('account')
    expect(JSON.parse(localStorage.getItem(KEY)).capturedAt).toBe(at)
  })
  it('ignores an account code older than the 30-day window', async () => {
    const mod = await import('../src/hooks/useReferralCapture')
    mod.restoreReferralFromAccount({ referredByCode: 'OLD', referredAt: new Date(Date.now() - 45 * DAY).toISOString() })
    expect(mod.getStoredReferralCode()).toBe('')
  })
  it('a newer code in the browser wins and is pushed to the account (last click wins)', async () => {
    localStorage.setItem('passthrough_token', 'tok')
    localStorage.setItem(KEY, JSON.stringify({ code: 'NEWER', capturedAt: Date.now() - 1000, source: 'link' }))
    const mod = await import('../src/hooks/useReferralCapture')
    mod.restoreReferralFromAccount({ referredByCode: 'OLDER', referredAt: new Date(Date.now() - 5 * DAY).toISOString() })
    expect(mod.getStoredReferralCode()).toBe('NEWER')
    expect(api.post).toHaveBeenCalledWith('/partners/attribution', { code: 'NEWER' })
  })
  it('a newer account code replaces an older browser one', async () => {
    localStorage.setItem(KEY, JSON.stringify({ code: 'OLDER', capturedAt: Date.now() - 9 * DAY, source: 'link' }))
    const mod = await import('../src/hooks/useReferralCapture')
    mod.restoreReferralFromAccount({ referredByCode: 'NEWER', referredAt: new Date(Date.now() - DAY).toISOString() })
    expect(mod.getStoredReferralCode()).toBe('NEWER')
  })
  it('a typed code is marked "typed", and removing it also clears the account', async () => {
    localStorage.setItem('passthrough_token', 'tok')
    const mod = await import('../src/hooks/useReferralCapture')
    mod.setStoredReferralCode('coach20')
    expect(mod.getStoredReferralSource()).toBe('typed')
    expect(api.post).toHaveBeenLastCalledWith('/partners/attribution', { code: 'COACH20' })
    mod.setStoredReferralCode('')
    expect(mod.getStoredReferralCode()).toBe('')
    expect(api.post).toHaveBeenLastCalledWith('/partners/attribution', { code: null })
  })
  it('signed out, nothing is sent to the account endpoint', async () => {
    const mod = await import('../src/hooks/useReferralCapture')
    mod.setStoredReferralCode('COACH20')
    expect(api.post).not.toHaveBeenCalled()
  })
})

describe('PartnerDashboard — payout statement and link reset', () => {
  const base = {
    name: 'Coach K', active: true, commissionRate: 0.2, currency: 'USD', hasPayoutDetails: true, payoutMethod: 'BANK', scope: 'dashboard',
    stats: { totalClicks: 5, totalConversions: 1, pendingCents: 0, paidCents: 200 }, referralCodes: [],
    payouts: [{ id: 'po1', amountCents: 200, currency: 'USD', paidAt: '2026-09-20T10:00:00Z', periodStart: '2026-09-01', periodEnd: '2026-09-15' }],
    cyclesSummary: [], olderUnpaidCents: 0, carriedForwardCents: 0, belowMinimum: false, minPayoutCents: 0, readyToPayCents: 0, creditCents: 0,
    conversions: [], conversionsTotal: 0,
  }
  async function mount() {
    const { default: PartnerDashboard } = await import('../src/pages/PartnerDashboard')
    api.get.mockImplementation(url => {
      if (url.startsWith('/partners/dashboard')) return Promise.resolve({ data: { data: base } })
      if (url.includes('payoutId=po1')) return Promise.resolve({ data: { data: [{ id: 'l1', code: 'K', commissionAmountCents: 300, createdAt: '2026-09-02T10:00:00Z' }, { id: 'l2', commissionAmountCents: -100, isReversal: true, createdAt: '2026-09-03T10:00:00Z' }] } })
      return Promise.reject(new Error(`unexpected GET ${url}`))
    })
    return render(<MemoryRouter initialEntries={['/partner/dashboard?token=TOK']}><PartnerDashboard /></MemoryRouter>)
  }
  beforeEach(() => { cleanup(); vi.resetModules(); api.get.mockReset(); api.post.mockReset() })

  it('"Sales in this payout" lists exactly the rows that payout settled, with their total', async () => {
    await mount()
    fireEvent.click(await screen.findByRole('button', { name: /sales in this payout/i }))
    const box = await screen.findByTestId('payout-statement')
    await waitFor(() => expect(box.textContent).toMatch(/Commission settled by this payout/))
    expect(box.textContent).toMatch(/\$2\.00/)    // 300 - 100
    expect(api.get.mock.calls.some(c => String(c[0]).includes('payoutId=po1'))).toBe(true)
  })

  it('"Reset my links" asks first, then posts, and says the old links stop working', async () => {
    api.post.mockResolvedValue({ data: { success: true, message: 'Done — we emailed your new links.' } })
    await mount()
    fireEvent.click(await screen.findByRole('button', { name: /reset my links/i }))
    expect(api.post).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /yes, reset both links/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/partners/reset-links', {}, expect.anything()))
    expect((await screen.findByRole('status')).textContent).toMatch(/no longer works/)
  })

  it('a failed reset shows the server message and offers to retry', async () => {
    api.post.mockRejectedValue({ response: { data: { message: 'We couldn’t send your new links, so nothing was changed.' } } })
    await mount()
    fireEvent.click(await screen.findByRole('button', { name: /reset my links/i }))
    fireEvent.click(screen.getByRole('button', { name: /yes, reset both links/i }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/nothing was changed/)
    expect(screen.getByRole('button', { name: /yes, reset both links/i })).toBeTruthy()
  })
})

describe('PartnerDetail — the low-price confirmation lives in the CODE modals only', () => {
  it('appears in create and edit code, and not in the edit-partner form', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync(`${process.cwd()}/frontend/src/pages/admin/PartnerDetail.jsx`, 'utf8')
    const editPartner = src.slice(src.indexOf('function EditPartnerModal'), src.indexOf('function AdjustBalanceModal'))
    expect(editPartner).not.toMatch(/confirm-low-price/)
    expect((src.match(/data-testid="confirm-low-price"/g) || []).length).toBe(2)
  })
})
