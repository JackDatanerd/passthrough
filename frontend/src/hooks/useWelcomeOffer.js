import { useEffect, useState } from 'react'
import api from '../lib/api'

// The signed-in account's personal welcome offer (backend: services/welcomeCode.service.js): one single-use code worth a share off
// the full fix, given when the account verified its email. Returns the offer
//   { code, percentOff, amountCents, listAmountCents, currency, expiresAt, tier: 'FIX' }
// or null: signed out, no code, spent, expired, or the request failed. It is a nicety, never a requirement, so a failure shows
// nothing instead of an error and the page simply prices as usual.
//
// The code is issued by a background task that runs just AFTER the verification response, so a page that loads right then can
// be told "no offer" a moment too early. For an account that is verified and new, an empty answer is therefore asked again a few
// times (2s, 4s, 8s) before it is believed; an older account, or one that has not verified yet, is asked once. The request is also
// repeated when the account becomes verified (the dashboard re-reads the user after the verification link is opened).
const RETRY_DELAYS_MS = [2000, 4000, 8000]
const FRESH_ACCOUNT_MS = 3 * 24 * 60 * 60 * 1000

function isFreshAccount(user) {
  const created = Date.parse(user?.createdAt || '')
  return !Number.isFinite(created) || Date.now() - created < FRESH_ACCOUNT_MS
}

export function useWelcomeOffer(user) {
  const userId = user?.id || null
  const verified = !!user?.emailVerified
  const fresh = isFreshAccount(user)
  const [offer, setOffer] = useState(null)
  useEffect(() => {
    if (!userId) { setOffer(null); return undefined }
    let cancelled = false
    let timer = null
    const ask = attempt => {
      api.get('/pricing/welcome-offer')
        .then(res => {
          if (cancelled) return
          const found = res?.data?.data?.offer || null
          setOffer(found)
          if (!found && verified && fresh && attempt < RETRY_DELAYS_MS.length) {
            timer = setTimeout(() => ask(attempt + 1), RETRY_DELAYS_MS[attempt])
          }
        })
        .catch(() => { if (!cancelled) setOffer(null) })
    }
    ask(0)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [userId, verified, fresh])
  // An offer that lapsed while the page was open is no offer (the server would refuse it anyway).
  return offer && Date.parse(offer.expiresAt) > Date.now() ? offer : null
}
