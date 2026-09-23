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
  const { postAuthActions } = useAuth()
  const [status, setStatus] = useState('loading') // loading | success | error
  const [message, setMessage] = useState('')
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return   // StrictMode double-invoke would otherwise burn the one-time token
    ran.current = true
    const token = params.get('token')
    if (!token) { setStatus('error'); setMessage('This link is missing its confirmation token.'); return }
    api.post('/auth/email/confirm', { token })
      .then(async res => {
        const { user, token: sessionToken } = res.data.data
        if (sessionToken && user) await postAuthActions(sessionToken, user)
        setStatus('success')
      })
      .catch(err => {
        setStatus('error')
        setMessage(getErrorMessage(err, 'The link is invalid or has expired.'))
      })
  }, [])

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
              <h1 className="text-xl font-bold text-gray-900 mb-2">Email updated</h1>
              <p className="text-sm text-gray-500 mb-6">
                Your account now uses this email address.
              </p>
              <Link to="/dashboard/settings"
                className="inline-block bg-blue-700 text-white px-5 py-2.5 rounded-md text-sm font-medium hover:bg-blue-800 transition-colors">
                Go to settings →
              </Link>
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
