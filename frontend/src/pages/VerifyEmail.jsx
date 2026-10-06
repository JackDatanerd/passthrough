import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import api, { getErrorMessage } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import Spinner from '../components/ui/Spinner'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'

// Email links point to FRONTEND_URL/verify-email?token=xxx — NOT the API URL
// This page reads the token from the URL and calls the API
export default function VerifyEmail() {
  const [params] = useSearchParams()
  const { user, refreshUser } = useAuth()
  // loading | success | error (the link itself is dead) | retry (we couldn't find out)
  const [status, setStatus] = useState('loading')
  const [detail, setDetail] = useState('')
  const [resend, setResend] = useState({ state: 'idle', message: '' })   // idle | sending | sent | failed
  const ran = useRef(false)
  const token = params.get('token')

  const verify = useCallback(() => {
    setStatus('loading'); setDetail('')
    api.get(`/auth/verify-email?token=${encodeURIComponent(token)}`)
      .then(() => {
        setStatus('success')
        // If this browser happens to already be logged in (e.g. the link
        // was opened in a new tab on the same device), refresh the cached
        // user object now — otherwise the emailVerified flag only updates
        // on this page, and any already-open dashboard/settings tab keeps
        // showing "unverified" until a full reload. refreshUser() no-ops
        // silently if there's no token in this browser at all.
        refreshUser()
      })
      .catch(err => {
        // Only a 400 means the server looked at the link and rejected it. A 429 (too many
        // attempts), a 5xx or no response at all says nothing about the link — telling the
        // person it is "invalid or expired" sent them off to request a new one (and, since the
        // old token stays valid, burned a resend) for what a retry would have fixed.
        if (err.response?.status === 400) { setStatus('error'); return }
        setDetail(getErrorMessage(err, "We couldn't reach the server."))
        setStatus('retry')
      })
  }, [token])

  useEffect(() => {
    // AUDIT FIX (Auth/Scan round): ConfirmEmailChange already guards against the
    // effect running twice (StrictMode in dev); this page didn't, so the second
    // request hit an already-used link and replaced the success screen with
    // "Verification failed". (The API also now answers a replayed link with
    // "already verified", covering double clicks and link scanners.)
    if (ran.current) return
    ran.current = true
    if (!token) { setStatus('error'); return }
    verify()
  }, [])

  async function sendNewLink() {
    setResend({ state: 'sending', message: '' })
    try {
      await api.post('/auth/resend-verification')
      setResend({ state: 'sent', message: 'New link sent — check your inbox.' })
    } catch (err) {
      setResend({ state: 'failed', message: getErrorMessage(err, "Couldn't send a new link. Please try again.") })
    }
  }

  const btn = 'inline-block bg-blue-700 text-white px-5 py-2.5 rounded-md text-sm font-medium hover:bg-blue-800 transition-colors disabled:opacity-60'

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <Navbar />
      <main className="flex-1 flex items-center justify-center px-4">
        <div className="w-full max-w-sm bg-white rounded-lg border border-gray-200 shadow-sm p-8 text-center">
          {status === 'loading' && (
            <>
              <Spinner size="lg" className="mx-auto mb-4" />
              <p className="text-gray-600">Verifying your email…</p>
            </>
          )}
          {status === 'success' && (
            <>
              <div className="text-green-500 text-4xl mb-3">✓</div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">Email verified</h1>
              <p className="text-sm text-gray-500 mb-6">
                You can now download your fixed resumes.
              </p>
              <Link to="/dashboard" className={btn}>
                Go to dashboard →
              </Link>
            </>
          )}
          {status === 'retry' && (
            <>
              <h1 className="text-xl font-bold text-gray-900 mb-2">Couldn't verify just now</h1>
              <p role="alert" className="text-sm text-gray-500 mb-6">
                {detail} Your link hasn't been used up — try again in a moment.
              </p>
              <button type="button" onClick={verify} className={btn}>Try again</button>
            </>
          )}
          {status === 'error' && (
            <>
              <div className="text-red-500 text-4xl mb-3">✕</div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">Verification failed</h1>
              <p className="text-sm text-gray-500 mb-6">
                {user
                  ? 'The link is invalid or has expired. We can send you a new one.'
                  : 'The link is invalid or has expired. Sign in and request a new one from your dashboard.'}
              </p>
              {user ? (
                <>
                  {resend.state !== 'sent' && (
                    <button type="button" onClick={sendNewLink} disabled={resend.state === 'sending'} className={btn}>
                      {resend.state === 'sending' ? 'Sending…' : 'Send me a new link'}
                    </button>
                  )}
                  {resend.message && (
                    <p role={resend.state === 'failed' ? 'alert' : 'status'}
                      className={`text-sm mt-3 ${resend.state === 'failed' ? 'text-red-600' : 'text-green-700'}`}>
                      {resend.message}
                    </p>
                  )}
                </>
              ) : (
                <Link to={`/login?next=${encodeURIComponent('/dashboard')}`}
                  className="text-sm text-blue-600 hover:underline">
                  Sign in
                </Link>
              )}
            </>
          )}
        </div>
      </main>
      <Footer />
    </div>
  )
}
