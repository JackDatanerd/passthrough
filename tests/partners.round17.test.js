// Section 4 round 17: (1) a code that prices only some tiers still credits the partner on the others, (2) the channel tag
// (&sub=) is kept on the account with the code, (3) the partner terms describe both.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')

describe('channel tag on the account — wiring', () => {
  const partners = read('src/controllers/partners.controller.js')
  const auth = read('src/controllers/auth.controller.js')
  it('the attribution endpoint accepts a tag and hands it to setUserAttribution', () => {
    expect(partners).toMatch(/sub: z\.string\(\)\.trim\(\)\.max\(40\)\.nullable\(\)\.optional\(\)\.catch\(undefined\)/)
    expect(partners).toMatch(/setUserAttribution\(supabase, user, body\.code \?\? null, body\.capturedAt, body\.sub \?\? null\)/)
  })
  it('registering carries the tag too, and puts it on the returned user', () => {
    expect(auth).toMatch(/referralSub: z\.string\(\)\.max\(40\)\.nullish\(\)\.catch\(undefined\)/)
    expect(auth).toMatch(/user\.referredSub = out\.referredSub \|\| null/)
  })
  it('the tag reaches the SPA on every authenticated user, and is cleared with the code', () => {
    expect(read('src/lib/authUser.js')).toMatch(/'referred_by_code', 'referred_at', 'referred_sub'/)
    expect(read('src/lib/mappers.js')).toMatch(/referredSub:\s+row\.referred_sub \?\? null/)
    expect(partners).toMatch(/referred_by_code: null, referred_at: null, referred_sub: null \}\)\.eq\('referred_by_code', rc\.code\)/)
  })
  it('the Register page sends the stored tag', () => {
    expect(read('frontend/src/pages/Register.jsx')).toMatch(/referralSub: getStoredReferralSub\(\) \|\| undefined/)
  })
})

describe('migration 0095', () => {
  const sql = read('supabase/migrations/0095_partners_section4_round17.sql')
  it('adds a format-checked users.referred_sub and scrubs it on account deletion', () => {
    expect(sql).toMatch(/alter table users add column if not exists referred_sub text/)
    expect(sql).toMatch(/referred_sub ~ '\^\[a-z0-9_-\]\{1,32\}\$'/)
    expect(sql).toMatch(/referred_at\s+= null,\s*referred_sub\s+= null/)
  })
})

describe('partner-facing copy', () => {
  it('the terms say a partly-priced code still credits every plan, and that signed-in accounts carry attribution across devices', () => {
    const terms = read('frontend/src/pages/PartnerTerms.jsx')
    expect(terms).toMatch(/only some plans, it still credits you for every plan/)
    expect(terms).toMatch(/once they are signed in — their account/)
  })
  it('the admin code forms no longer say a blank tier keeps the buyer undiscounted without credit', () => {
    expect(read('frontend/src/pages/admin/PartnerDetail.jsx')).toMatch(/the partner still earns commission on it/)
    expect(read('frontend/src/pages/admin/AdminPartners.jsx')).toMatch(/the partner still earns commission on it/)
  })
})
