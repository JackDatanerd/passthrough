import { useEffect, useState } from 'react'
import api from '../lib/api'

// The signed-in account's personal welcome offer (backend: services/welcomeCode.service.js): one single-use code worth a share off
// the full fix, given when the account verified its email. Returns the offer
//   { code, percentOff, amountCents, listAmountCents, currency, expiresAt, tier: 'FIX' }
// or null: signed out, no code, spent, expired, or the request failed. It is a nicety, never a requirement, so a failure shows
// nothing instead of an error and the page simply prices as usual.
export function useWelcomeOffer(user) {
  const userId = user?.id || null
  const [offer, setOffer] = useState(null)
  useEffect(() => {
    if (!userId) { setOffer(null); return undefined }
    let cancelled = false
    api.get('/pricing/welcome-offer')
      .then(res => { if (!cancelled) setOffer(res?.data?.data?.offer || null) })
      .catch(() => { if (!cancelled) setOffer(null) })
    return () => { cancelled = true }
  }, [userId])
  // An offer that lapsed while the page was open is no offer (the server would refuse it anyway).
  return offer && Date.parse(offer.expiresAt) > Date.now() ? offer : null
}
