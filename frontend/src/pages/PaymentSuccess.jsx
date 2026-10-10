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
// G3 (round 4): after the fast polls above give up, keep checking quietly, slowly, for a few more
// minutes — a mobile-money approval can take longer than 16 seconds, and the buyer should be taken
// to their resume the moment it clears instead of having to find the "Check again" link. Spaced
// so the whole sequence stays inside rl.paymentVerify's 20-per-5-minutes budget (5 + 10 calls).
const SLOW_POLL_MAX_ATTEMPTS = 15
const SLOW_POLL_MS = 30000
// A 429 from the verify limiter clears within its 5-minute window; one short wait is enough for a
// single stray burst, and the on-screen link covers anything longer.
const RATE_LIMIT_RETRY_MS = 65000

export default function PaymentSuccess() {
  const [params]  = useSearchParams()
  const navigate  = useNavigate()
  const [status,  setStatus ] = useState('loading') // loading | pending | success | still-pending | session-expired | needs-support | rate-limited | duplicate | declined | no-reference | error
  const [scanId,  setScanId ] = useState(null)
  // Round 6: the server says this payment was a SECOND one for a resume already delivered by an earlier
  // payment, and whether its automatic refund is on the way ('QUEUED') or needs a human ('REVIEW').
  const [duplicate, setDuplicate] = useState(null)
  const [supportMessage, setSupportMessage] = useState('')
  const [declinedMessage, setDeclinedMessage] = useState('')

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
    return () => { mountedRef.current = false; clearTimeout(pollTimerRef.current) }
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
  const rateRetriesRef = useRef(0)
  // ONE scheduled re-check at a time: a manual "Check again" while a slow poll is waiting must
  // replace it, not run alongside it (two chains would double the calls against the verify limiter).
  const pollTimerRef = useRef(null)
  function scheduleVerify(attempt, ms) {
    clearTimeout(pollTimerRef.current)
    pollTimerRef.current = setTimeout(() => verify(attempt), ms)
  }

  function verify(attempt = 1) {
    // AUDIT FIX (Section 3/4 pass, bug): see mountedRef's comment above —
    // bail before touching state OR making the network call at all, so an
    // unmounted retry doesn't even poll Paystack pointlessly.
    if (!mountedRef.current) return
    clearTimeout(pollTimerRef.current)
    if (!reference) { setStatus('no-reference'); return }
    setStatus(attempt > PENDING_MAX_ATTEMPTS ? 'still-pending' : attempt > 1 ? 'pending' : 'loading')
    // AUDIT FIX (Payments & Pricing pass 1, bug): `reference` went straight
    // into the query string unencoded. Paystack references are normally
    // URL-safe, but nothing here actually guarantees that — encoding costs
    // nothing and removes the assumption.
    api.get(`/payments/verify?reference=${encodeURIComponent(reference)}`)
      .then(res => {
        if (!mountedRef.current) return
        errorRetriesRef.current = 0
        rateRetriesRef.current = 0
        // AUDIT FIX (bug): a 202 { pending: true } means Paystack hasn't
        // reached a final status yet — not a failure. Keep polling a bounded
        // number of times before settling on "still processing" rather than
        // ever showing this as an error.
        if (res.data.pending) {
          if (res.data.data?.scanId) setScanId(res.data.data.scanId)
          if (attempt < PENDING_MAX_ATTEMPTS) {
            setStatus('pending')
            scheduleVerify(attempt + 1, PENDING_RETRY_MS)
          } else {
            setStatus('still-pending')
            if (attempt < PENDING_MAX_ATTEMPTS + SLOW_POLL_MAX_ATTEMPTS)
              scheduleVerify(attempt + 1, SLOW_POLL_MS)
          }
          return
        }
        const sid = res.data.data.scanId
        setScanId(sid)
        // PAYMENTS & PRICING ROUND 6 (feature gap): a double charge used to read exactly like a normal
        // success. Say so, and do NOT auto-redirect — the buyer has to be able to read it.
        if (res.data.data.duplicate) {
          setDuplicate({ refund: res.data.data.refund === 'QUEUED' ? 'QUEUED' : 'REVIEW' })
          setStatus('duplicate')
          return
        }
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
        const httpStatus = err?.response?.status
        if (httpStatus === 401) { setStatus('session-expired'); return }
        // AUDIT FIX (Payments & Pricing round 2, bug — B6): the server now says
        // 409 + needsSupport when the payment was received but nothing could be
        // delivered (scan/account gone, refunded/disputed). Used to be a false
        // "Payment confirmed!" + redirect; now an honest, retry-free state.
        if (httpStatus === 409 && err.response?.data?.needsSupport) {
          setSupportMessage(err.response.data.message || '')
          setStatus('needs-support')
          return
        }
        // AUDIT FIX (Payments & Pricing round 2, bug — B7): the retry budget
        // below is for TRANSIENT failures (a network blip, a 5xx). A 429 from
        // rl.paymentVerify and a deterministic 400/404 (declined payment, a
        // reference that isn't this account's) used to burn it too — ~3s of
        // pointless re-asking, then a "Verification failed" that for a 429
        // wasn't even true. A 429 gets its own wait-and-check-again state; other
        // 4xx go straight to the failure screen.
        // Round 6 (bug): a 429 used to end the polling chain for good — the buyer had to notice and
        // click "Check again", which then restarted the whole fast+slow cycle against the same limiter.
        // Retry the SAME attempt once the window has had time to clear (twice at most); the manual
        // link stays for anyone who wants it sooner.
        if (httpStatus === 429) {
          setStatus('rate-limited')
          if (rateRetriesRef.current < 2) {
            rateRetriesRef.current += 1
            scheduleVerify(attempt, RATE_LIMIT_RETRY_MS)
          }
          return
        }
        // G2 (round 4): Paystack says the payment definitely did not go through.
        if (httpStatus === 400 && err.response?.data?.declined) {
          if (err.response.data.data?.scanId) setScanId(err.response.data.data.scanId)
          setDeclinedMessage(err.response.data.message || '')
          setStatus('declined')
          return
        }
        if (httpStatus && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408) { setStatus('error'); return }
        if (errorRetriesRef.current < 2) {
          errorRetriesRef.current += 1
          scheduleVerify(attempt, 1500)   // same attempt — not a pending-poll advance
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
                  Some payment methods need an extra approval step — this can take a minute or two.
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
          {status === 'duplicate' && (
            <>
              <div className="text-green-500 text-5xl mb-4">✓</div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">Your resume is ready — you were charged twice</h1>
              <p className="text-sm text-gray-500 mb-4">
                You'd already paid for this resume, so this second payment bought nothing extra. Your resume is unaffected.{' '}
                {duplicate?.refund === 'QUEUED'
                  ? "We've started refunding the extra payment to your original payment method — it can take a few business days to appear."
                  : "We couldn't start the refund automatically, but we've been alerted and will refund it. You can also email support with the reference below."}
              </p>
              {reference && <p className="text-xs text-gray-400 mb-4 font-mono break-all">Reference: {reference}</p>}
              <div className="flex items-center justify-center gap-4">
                {scanId && <a href={`/scan/${scanId}`} className="text-sm font-medium text-blue-600 hover:underline">Go to your resume</a>}
                <a href="mailto:support@passthrough.dev" className="text-sm text-blue-600 hover:underline">Email support</a>
              </div>
            </>
          )}
          {status === 'still-pending' && (
            <>
              <div className="text-amber-500 text-5xl mb-4">⏳</div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">Still processing</h1>
              <p className="text-sm text-gray-500 mb-4">
                Your payment hasn't failed — it's just taking longer than usual to confirm (some payment methods need an extra approval step).
                We'll finish this automatically the moment it clears. Check again in a bit, or check your dashboard.
              </p>
              <div className="flex items-center justify-center gap-4">
                <button type="button" onClick={() => verify()} className="text-sm text-blue-600 hover:underline">
                  Check again
                </button>
                {scanId && <a href={`/scan/${scanId}`} className="text-sm text-blue-600 hover:underline">Back to your resume</a>}
                <a href="/dashboard" className="text-sm text-blue-600 hover:underline">
                  Go to dashboard
                </a>
              </div>
            </>
          )}
          {status === 'declined' && (
            <>
              <div className="text-red-500 text-5xl mb-4">✕</div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">Payment not completed</h1>
              <p className="text-sm text-gray-500 mb-4">
                {declinedMessage || 'This payment was not completed, so you have not been charged.'}
              </p>
              <div className="flex items-center justify-center gap-4">
                {scanId && <a href={`/scan/${scanId}`} className="text-sm font-medium text-blue-600 hover:underline">Back to your resume</a>}
                <a href="/dashboard" className="text-sm text-blue-600 hover:underline">Go to dashboard</a>
              </div>
            </>
          )}
          {status === 'no-reference' && (
            <>
              <div className="text-amber-500 text-5xl mb-4">?</div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">We couldn't find a payment to check</h1>
              <p className="text-sm text-gray-500 mb-4">
                This page needs the payment reference Paystack adds to the link. If you just paid, your payment is safe —
                open your dashboard to see it, or email support@passthrough.dev.
              </p>
              <div className="flex items-center justify-center gap-4">
                <a href="/dashboard/payments" className="text-sm font-medium text-blue-600 hover:underline">View my payments</a>
                <a href="/dashboard" className="text-sm text-blue-600 hover:underline">Go to dashboard</a>
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
          {status === 'needs-support' && (
            <>
              <div className="text-amber-500 text-5xl mb-4">⚠</div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">We need to look at this payment</h1>
              <p className="text-sm text-gray-500 mb-4">
                {supportMessage || 'We received your payment but could not complete your order automatically. We have been notified.'}
              </p>
              <div className="flex items-center justify-center gap-4">
                <a href="mailto:support@passthrough.dev" className="text-sm text-blue-600 hover:underline">Email support</a>
                <a href="/dashboard" className="text-sm text-blue-600 hover:underline">Go to dashboard</a>
              </div>
            </>
          )}
          {status === 'rate-limited' && (
            <>
              <div className="text-amber-500 text-5xl mb-4">⏳</div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">Checking too fast</h1>
              <p className="text-sm text-gray-500 mb-4">
                We've checked your payment a lot in a short time. Your payment is unaffected — we'll check again automatically in about a minute, or you can check now.
              </p>
              <div className="flex items-center justify-center gap-4">
                <button type="button" onClick={() => verify()} className="text-sm text-blue-600 hover:underline">Check again</button>
                <a href="/dashboard" className="text-sm text-blue-600 hover:underline">Go to dashboard</a>
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
