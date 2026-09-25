import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import api from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import Spinner from '../components/ui/Spinner'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'

// Email links point to FRONTEND_URL/verify-email?token=xxx — NOT the API URL
// This page reads the token from the URL and calls the API
export default function VerifyEmail() {
  const [params] = useSearchParams()
  const { refreshUser } = useAuth()
  const [status, setStatus] = useState('loading') // loading | success | error
  const ran = useRef(false)

  useEffect(() => {
    // AUDIT FIX (Auth/Scan round): ConfirmEmailChange already guards against the
    // effect running twice (StrictMode in dev); this page didn't, so the second
    // request hit an already-used link and replaced the success screen with
    // "Verification failed". (The API also now answers a replayed link with
    // "already verified", covering double clicks and link scanners.)
    if (ran.current) return
    ran.current = true
    const token = params.get('token')
    if (!token) { setStatus('error'); return }
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
      .catch(() => setStatus('error'))
  }, [])

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
              <Link to="/dashboard"
                className="inline-block bg-blue-700 text-white px-5 py-2.5 rounded-md text-sm font-medium hover:bg-blue-800 transition-colors">
                Go to dashboard →
              </Link>
            </>
          )}
          {status === 'error' && (
            <>
              <div className="text-red-500 text-4xl mb-3">✕</div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">Verification failed</h1>
              <p className="text-sm text-gray-500 mb-6">
                The link is invalid or has expired. Request a new one from your dashboard.
              </p>
              <Link to="/login"
                className="text-sm text-blue-600 hover:underline">
                Sign in
              </Link>
            </>
          )}
        </div>
      </main>
      <Footer />
    </div>
  )
}
