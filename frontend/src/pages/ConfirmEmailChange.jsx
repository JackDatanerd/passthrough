import { useEffect, useState, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import api, { getErrorMessage } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import Spinner from '../components/ui/Spinner'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'

// FEATURE GAP CLOSED (Section 6, second fixing-time pass): the other half of
// Settings.jsx's "confirm your new email" flow. auth.controller.js's
// updateEmail only ever STAGES a change now (see its own comment) — this is
// the page the confirmation link actually lands on, and the only place the
// change becomes real. Modeled on VerifyEmail.jsx, with two differences that
// come straight from confirmEmailChange's response shape: the endpoint is a
// POST with the token in the body (not a GET with it in the query string),
// and a successful confirm returns a fresh session token + user, because the
// account's own email — the thing THIS session's JWT is bound to — just
// changed. postAuthActions stores both, so a tab that was already signed in
// as this account (the common case: the person confirming from the same
// browser is usually the one who requested the change) picks up the new
// identity immediately instead of showing a stale email until next login.
export default function ConfirmEmailChange() {
  const [params] = useSearchParams()
  const { postAuthActions, logout } = useAuth()
  const [status, setStatus] = useState('loading') // loading | success | error
  const [message, setMessage] = useState('')
  const [keptOtherSession, setKeptOtherSession] = useState(false)
  // AUDIT FIX (Auth round 2, B1): the API now only completes a change for a
  // session of the account itself. 'signin' = nobody signed in (or signed in as
  // someone else): nothing was consumed, the same link works once they are.
  const [signInReason, setSignInReason] = useState(null)   // 'SIGNED_OUT' | 'WRONG_ACCOUNT'
  // AUDIT FIX (Auth section round 1): opening this link a SECOND time (a mail
  // scanner, a double tap, the back button) used to hit the generic 400
  // "invalid or expired" branch below — indistinguishable from a genuinely
  // dead link — for an address that HAD just been confirmed. The backend now
  // answers a replay with { alreadyConfirmed: true } and no token/user (see
  // confirmEmailChange's own comment): nothing to adopt, nothing wrong either.
  const [alreadyConfirmed, setAlreadyConfirmed] = useState(false)
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return   // StrictMode double-invoke would otherwise burn the one-time token
    ran.current = true
    const token = params.get('token')
    if (!token) { setStatus('error'); setMessage('This link is missing its confirmation token.'); return }
    api.post('/auth/email/confirm', { token })
      .then(async res => {
        const { user, token: sessionToken, alreadyConfirmed: replay } = res.data.data
        if (replay) { setAlreadyConfirmed(true); setStatus('success'); return }
        // AUDIT FIX (Auth/Scan round): this used to adopt the returned session
        // unconditionally — so following a confirmation link in a browser
        // that was signed in as a DIFFERENT account silently swapped that
        // session for this one (and claimed the browser's anonymous scans
        // into it). Adopt it only when nobody is signed in, or the browser is
        // already this same account; otherwise leave the existing session
        // alone and say to sign in.
        let signedInAs = null
        try { signedInAs = JSON.parse(localStorage.getItem('passthrough_user'))?.id ?? null } catch (_) { /* ignore */ }
        const hasSession = !!localStorage.getItem('passthrough_token')
        const sameAccount = signedInAs && user && signedInAs === user.id
        if (sessionToken && user && (!hasSession || sameAccount)) await postAuthActions(sessionToken, user)
        else setKeptOtherSession(true)
        setStatus('success')
      })
      .catch(err => {
        if (err.response?.data?.code === 'SIGN_IN_REQUIRED') {
          setSignInReason(err.response.data.reason || 'SIGNED_OUT')
          setMessage(getErrorMessage(err, 'Sign in to confirm this change.'))
          setStatus('signin')
          return
        }
        setStatus('error')
        setMessage(getErrorMessage(err, 'The link is invalid or has expired.'))
      })
  }, [])

  // Back to THIS link after signing in (Login validates ?next= via safeNext).
  const linkToken = params.get('token')
  const loginHref = linkToken
    ? `/login?next=${encodeURIComponent(`/confirm-email-change?token=${linkToken}`)}`
    : '/login'

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <Navbar />
      <main className="flex-1 flex items-center justify-center px-4">
        <div className="w-full max-w-sm bg-white rounded-lg border border-gray-200 shadow-sm p-8 text-center">
          {status === 'loading' && (
            <>
              <Spinner size="lg" className="mx-auto mb-4" />
              <p className="text-gray-600">Confirming your new email…</p>
            </>
          )}
          {status === 'success' && (
            <>
              <div className="text-green-500 text-4xl mb-3">✓</div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">
                {alreadyConfirmed ? 'Already confirmed' : 'Email updated'}
              </h1>
              <p className="text-sm text-gray-500 mb-6">
                {alreadyConfirmed
                  ? 'This link has already been used and your email was updated earlier.'
                  : keptOtherSession
                  ? 'The account now uses this email address. You are signed in to a different account in this browser, so sign out and sign in with the new email to use it.'
                  : 'Your account now uses this email address.'}
              </p>
              <Link to="/dashboard/settings"
                className="inline-block bg-blue-700 text-white px-5 py-2.5 rounded-md text-sm font-medium hover:bg-blue-800 transition-colors">
                Go to settings →
              </Link>
            </>
          )}
          {status === 'signin' && (
            <>
              <h1 className="text-xl font-bold text-gray-900 mb-2">Sign in to confirm</h1>
              <p className="text-sm text-gray-500 mb-6">{message}</p>
              {signInReason === 'WRONG_ACCOUNT' ? (
                <button type="button" onClick={async () => { await Promise.race([logout(), new Promise(r => setTimeout(r, 3000))]); window.location.assign(loginHref) }}
                  className="inline-block bg-blue-700 text-white px-5 py-2.5 rounded-md text-sm font-medium hover:bg-blue-800 transition-colors">
                  Sign out and sign in
                </button>
              ) : (
                <Link to={loginHref}
                  className="inline-block bg-blue-700 text-white px-5 py-2.5 rounded-md text-sm font-medium hover:bg-blue-800 transition-colors">
                  Sign in
                </Link>
              )}
            </>
          )}
          {status === 'error' && (
            <>
              <div className="text-red-500 text-4xl mb-3">✕</div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">Confirmation failed</h1>
              <p className="text-sm text-gray-500 mb-6">{message}</p>
              <Link to="/dashboard/settings"
                className="text-sm text-blue-600 hover:underline">
                Back to settings
              </Link>
            </>
          )}
        </div>
      </main>
      <Footer />
    </div>
  )
}
