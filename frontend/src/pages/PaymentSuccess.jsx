import { useEffect, useRef, useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import api from '../lib/api'
import { safeNext } from '../lib/session'
import Spinner from '../components/ui/Spinner'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'

// AUDIT FIX (bug): a still-processing payment (Paystack's non-terminal
// ongoing/pending/processing/queued statuses — see paystack.service.js's
// isPendingStatus — common on mobile-money "pay with transfer"/OTP channels)
// used to be indistinguishable here from a genuine failure: verifyPayment
// returned the same generic error for both, so a customer whose money was
// still on its way saw "Verification failed" like anyone whose card was
// actually declined. This caps how long we keep polling before falling back
// to an honest "still processing" message instead — the backend's hourly
// sweep finishes the job automatically regardless, this only changes what
// the customer sees while that happens.
const PENDING_MAX_ATTEMPTS = 5
const PENDING_RETRY_MS = 4000

export default function PaymentSuccess() {
  const [params]  = useSearchParams()
  const navigate  = useNavigate()
  const [status,  setStatus ] = useState('loading') // loading | pending | success | still-pending | session-expired | error
  const [scanId,  setScanId ] = useState(null)

  const reference = params.get('reference') || params.get('trxref')

  // AUDIT FIX (Section 3/4 pass, bug): the recursive setTimeout chain below
  // (pending-poll retries, the error retry, the post-success redirect) was
  // never tied to this component's lifecycle — nothing cancelled it if the
  // user navigated away mid-poll (back button, a manual nav elsewhere while
  // "Confirming your payment…" was showing). A payment that resolved as
  // 'success' *after* that point would still fire, and its trailing
  // navigate(`/scan/${sid}`) would forcibly yank the user to that page from
  // wherever they'd since moved to, with nothing warning them it was coming.
  // mountedRef gates every step of verify() below — once unmounted, no
  // further setState, no further polling, and no surprise navigate.
  // usePricing.js (same section) already uses this exact pattern for its
  // own async effects; this was the one place in the section that didn't.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // BUGFIX: previously any failure here — a network blip, a brief 5xx,
  // even a genuine amount-mismatch 400 — collapsed into the same
  // permanent "Verification failed" screen with no way to retry short of
  // navigating away. verifyPayment is a LIVE call out to Paystack, not
  // just a DB read, so a single transient hiccup on that one request
  // shouldn't be able to strand someone who legitimately just paid. One
  // automatic retry handles the transient case silently; a manual "Try
  // again" button covers anything slower than that without forcing a full
  // page reload.
  // AUDIT FIX (bug): this used to read `status === 'pending'` here to decide
  // whether a retry should stay on the "Still confirming…" copy. That never
  // actually worked: `verify` is a plain function re-created every render,
  // but the retry chain below (`setTimeout(() => verify(attempt + 1), ...)`)
  // is kicked off once from the mount-only effect, so every recursive call
  // reuses THAT render's closure — `status` inside it stays frozen at
  // whatever it was on mount ('loading'), never the current state. The
  // check was therefore always false, so every 4s poll flipped the screen
  // back to "Confirming your payment…" for a beat before flipping back to
  // "Still confirming…" once the fetch resolved — a flicker on exactly the
  // path (repeated mobile-money polling) this screen was written to smooth
  // over. `attempt > 1` alone is the correct condition with no state read
  // needed: this function only ever gets called with attempt > 1 from the
  // scheduled retry inside the `res.data.pending` branch below, so by
  // construction a retry IS a still-pending poll.
  // AUDIT FIX (Payments & Pricing pass 1, bug — B5): the catch below used to
  // gate its OWN retry on the very same `attempt` counter the pending-poll
  // loop advances (up to PENDING_MAX_ATTEMPTS). So a transient network error
  // on attempt 1 got one silent retry, but the identical transient error on
  // attempt 3, 4 or 5 — i.e. a payment we've ALREADY confirmed is still
  // processing — got attempt < 2 === false and jumped straight to a hard
  // "Verification failed", no retry at all. A network hiccup late in a poll
  // sequence is if anything less alarming than one on the first try, not
  // more. errorRetriesRef is its own small budget, independent of how far
  // into the pending-poll sequence we are, and resets on every successful
  // response (pending or final) so it never carries stale count forward.
  const errorRetriesRef = useRef(0)

  function verify(attempt = 1) {
    // AUDIT FIX (Section 3/4 pass, bug): see mountedRef's comment above —
    // bail before touching state OR making the network call at all, so an
    // unmounted retry doesn't even poll Paystack pointlessly.
    if (!mountedRef.current) return
    if (!reference) { setStatus('error'); return }
    setStatus(attempt > 1 ? 'pending' : 'loading')
    // AUDIT FIX (Payments & Pricing pass 1, bug): `reference` went straight
    // into the query string unencoded. Paystack references are normally
    // URL-safe, but nothing here actually guarantees that — encoding costs
    // nothing and removes the assumption.
    api.get(`/payments/verify?reference=${encodeURIComponent(reference)}`)
      .then(res => {
        if (!mountedRef.current) return
        errorRetriesRef.current = 0
        // AUDIT FIX (bug): a 202 { pending: true } means Paystack hasn't
        // reached a final status yet — not a failure. Keep polling a bounded
        // number of times before settling on "still processing" rather than
        // ever showing this as an error.
        if (res.data.pending) {
          if (attempt < PENDING_MAX_ATTEMPTS) {
            setStatus('pending')
            setTimeout(() => verify(attempt + 1), PENDING_RETRY_MS)
          } else {
            setStatus('still-pending')
          }
          return
        }
        const sid = res.data.data.scanId
        setScanId(sid)
        setStatus('success')
        // Guarded separately from the mountedRef check above: this fires
        // 2s LATER, so a user who navigated away during that window (not
        // before the check above ran) must still not get force-redirected.
        setTimeout(() => { if (mountedRef.current) navigate(`/scan/${sid}`) }, 2000)
      })
      .catch(err => {
        if (!mountedRef.current) return
        // FEATURE GAP CLOSED (Payments & Pricing pass 1 — G3): a 401 here
        // means the session expired (or was ended by api.js's interceptor,
        // which has already cleared the stored token by the time this catch
        // runs — see lib/api.js's endSession). /payment/success isn't in
        // isProtectedPath (lib/session.js), so nothing redirected the user
        // away, but every retry from here on would 401 again with no token
        // to send — this used to fall through to the generic transient-error
        // retry, burn its budget, and land on "Verification failed" with no
        // hint that signing back in was the actual fix. The payment itself
        // is untouched either way: it already succeeded or is still
        // processing on Paystack's side regardless of whether this browser
        // has a valid session to ask about it.
        if (err?.response?.status === 401) { setStatus('session-expired'); return }
        if (errorRetriesRef.current < 2) {
          errorRetriesRef.current += 1
          setTimeout(() => verify(attempt), 1500)   // same attempt — not a pending-poll advance
          return
        }
        setStatus('error')
      })
  }

  useEffect(() => { verify() }, [])

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <Navbar />
      <main className="flex-1 flex items-center justify-center px-4">
        <div className="w-full max-w-sm bg-white rounded-xl border border-gray-200 shadow-sm p-8 text-center">
          {(status === 'loading' || status === 'pending') && (
            <>
              <Spinner size="lg" className="mx-auto mb-4" />
              <p className="text-gray-600">
                {status === 'pending' ? 'Still confirming your payment…' : 'Confirming your payment…'}
              </p>
              {status === 'pending' && (
                <p className="text-xs text-gray-400 mt-2">
                  This can take a minute or two for mobile money — hang tight.
                </p>
              )}
            </>
          )}
          {status === 'success' && (
            <>
              <div className="text-green-500 text-5xl mb-4">✓</div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">Payment confirmed!</h1>
              <p className="text-sm text-gray-500">
                Generating your resume. Redirecting…
              </p>
            </>
          )}
          {status === 'still-pending' && (
            <>
              <div className="text-amber-500 text-5xl mb-4">⏳</div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">Still processing</h1>
              <p className="text-sm text-gray-500 mb-4">
                Your payment hasn't failed — it's just taking longer than usual to confirm (common for mobile money).
                We'll finish this automatically the moment it clears. Check again in a bit, or check your dashboard.
              </p>
              <div className="flex items-center justify-center gap-4">
                <button type="button" onClick={() => verify()} className="text-sm text-blue-600 hover:underline">
                  Check again
                </button>
                <a href="/dashboard" className="text-sm text-blue-600 hover:underline">
                  Go to dashboard
                </a>
              </div>
            </>
          )}
          {status === 'session-expired' && (
            <>
              <div className="text-amber-500 text-5xl mb-4">🔒</div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">Sign in to confirm your payment</h1>
              <p className="text-sm text-gray-500 mb-4">
                Your session expired while we were checking your payment. Your payment itself is unaffected —
                sign back in and we'll pick up right where we left off.
              </p>
              <div className="flex items-center justify-center gap-4">
                <a
                  href={`/login?next=${encodeURIComponent(safeNext(window.location.pathname + window.location.search) || '/dashboard')}`}
                  className="text-sm font-medium text-blue-600 hover:underline"
                >
                  Sign in
                </a>
              </div>
            </>
          )}
          {status === 'error' && (
            <>
              <div className="text-red-500 text-5xl mb-4">✕</div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">Verification failed</h1>
              <p className="text-sm text-gray-500 mb-4">
                Your payment may still have gone through. Try again, check your dashboard, or email us at support@passthrough.dev.
              </p>
              <div className="flex items-center justify-center gap-4">
                <button type="button" onClick={() => verify()} className="text-sm text-blue-600 hover:underline">
                  Try again
                </button>
                <a href="/dashboard" className="text-sm text-blue-600 hover:underline">
                  Go to dashboard
                </a>
              </div>
            </>
          )}
        </div>
      </main>
      <Footer />
    </div>
  )
}
