import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Focused coverage for the payout-link admin fallback (AUDIT FIX, feature
// gap) — adminResendPayoutLink and adminRegeneratePayoutLink previously
// only reported whether the EMAIL sent, with no way for the admin to
// recover the URL itself if delivery failed. This locks in that both now
// echo payoutUrl back in their response, while leaving partnerRowToCamel's
// existing "never expose the token" invariant everywhere else untouched.

function setup(opts = {}) {
  const state = { emailSent: [] }
  const db = createFakeSupabase(q => {
    if (q.table === 'partners' && q.op === 'select') return { data: opts.partner ?? null, error: null }
    if (q.table === 'partners' && q.op === 'update')  return { data: opts.partner ?? null, error: null }
    return undefined
  })
  const { mod, restore } = loadWithStubs('controllers/partners.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': {
      sendPartnerPayoutDetailsRequest: async () => { state.emailSent.push('resend'); return opts.emailOk ?? true },
      sendPartnerLinkRegenerated:      async () => { state.emailSent.push('regenerate'); return opts.emailOk ?? true },
    },
  })
  const env = { FRONTEND_URL: 'https://passthrough.dev' }
  const c = () => ({
    env,
    req: { param: () => 'p1' },
    json: (body, status = 200) => ({ body, status }),
  })
  return { mod, restore, state, c }
}

let t
afterEach(() => t?.restore())

describe('adminResendPayoutLink', () => {
  it('returns payoutUrl built from the existing token, alongside success', async () => {
    t = setup({ partner: { name: 'Coach K', email: 'k@x.co', payout_details_token: 'tok123' } })
    const res = await t.mod.adminResendPayoutLink(t.c())
    expect(res.body.success).toBe(true)
    expect(res.body.payoutUrl).toBe('https://passthrough.dev/partner/payout-details?token=tok123')
  })

  it('still returns payoutUrl even when the email send itself fails', async () => {
    t = setup({ partner: { name: 'Coach K', email: 'k@x.co', payout_details_token: 'tok123' }, emailOk: false })
    const res = await t.mod.adminResendPayoutLink(t.c())
    expect(res.body.success).toBe(false)
    expect(res.body.payoutUrl).toBe('https://passthrough.dev/partner/payout-details?token=tok123')
  })

  it('404s with no payoutUrl at all when the partner does not exist', async () => {
    t = setup({ partner: null })
    const res = await t.mod.adminResendPayoutLink(t.c())
    expect(res.status).toBe(404)
    expect(res.body.payoutUrl).toBeUndefined()
  })
})

describe('adminRegeneratePayoutLink', () => {
  it('returns payoutUrl built from the freshly rotated token', async () => {
    t = setup({ partner: { name: 'Coach K', email: 'k@x.co' } })
    const res = await t.mod.adminRegeneratePayoutLink(t.c())
    expect(res.body.success).toBe(true)
    expect(res.body.payoutUrl).toMatch(/^https:\/\/passthrough\.dev\/partner\/payout-details\?token=.+/)
  })

  it('still returns payoutUrl even when the notification email fails', async () => {
    t = setup({ partner: { name: 'Coach K', email: 'k@x.co' }, emailOk: false })
    const res = await t.mod.adminRegeneratePayoutLink(t.c())
    expect(res.body.emailed).toBe(false)
    expect(res.body.payoutUrl).toBeTruthy()
  })
})
