import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import api from '../lib/api'
import { useApi } from '../hooks/useApi'
import Button from '../components/ui/Button'
import Form from '../components/ui/Form'
import Input from '../components/ui/Input'
import Spinner from '../components/ui/Spinner'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'

export default function ResetPassword() {
  const navigate  = useNavigate()
  const [params]  = useSearchParams()
  const token     = params.get('token')
  const [newPassword, setNewPassword] = useState('')
  const [confirm,     setConfirm    ] = useState('')
  const [success,     setSuccess    ] = useState(false)
  const { loading, error, execute } = useApi()

  // FEATURE GAP CLOSED (Auth/Scan round): the page used to find out the link
  // was dead only AFTER the person had typed a new password and submitted.
  // If the check itself can't be answered (network blip, 5xx) the form is
  // shown anyway — the submit is still the real authority.
  const [tokenStatus, setTokenStatus] = useState(token ? 'checking' : 'invalid') // checking | valid | invalid
  useEffect(() => {
    if (!token) return
    let cancelled = false
    api.get(`/auth/reset-password/validate?token=${encodeURIComponent(token)}`)
      .then(res => { if (!cancelled) setTokenStatus(res.data?.data?.valid ? 'valid' : 'invalid') })
      .catch(() => { if (!cancelled) setTokenStatus('valid') })
    return () => { cancelled = true }
  }, [token])
  // Don't navigate after the person has already left this page.
  const redirectTimer = useRef(null)
  useEffect(() => () => clearTimeout(redirectTimer.current), [])

  if (tokenStatus === 'checking') {
    return (
      <div className="min-h-screen flex flex-col bg-gray-50">
        <Navbar />
        <main className="flex-1 flex items-center justify-center px-4">
          <div className="text-center">
            <Spinner size="lg" className="mx-auto mb-4" />
            <p className="text-gray-600">Checking your reset link…</p>
          </div>
        </main>
        <Footer />
      </div>
    )
  }

  if (!token || tokenStatus === 'invalid') {
    return (
      <div className="min-h-screen flex flex-col bg-gray-50">
        <Navbar />
        <main className="flex-1 flex items-center justify-center px-4">
          <div className="text-center">
            <p className="text-gray-600 mb-4">This reset link is invalid, has already been used, or has expired.</p>
            <Link to="/forgot-password" className="text-blue-600 hover:underline text-sm">
              Request a new one
            </Link>
          </div>
        </main>
        <Footer />
      </div>
    )
  }

  function fail(message) {
    return execute(() => Promise.reject(new Error(message)), { fallback: message }).catch(() => {})
  }

  async function handleSubmit() {
    if (!newPassword) return fail('Password required.')
    if (newPassword.length < 8) return fail('Password must be at least 8 characters.')
    if (newPassword !== confirm) return fail('Passwords do not match.')
    try {
      await execute(() => api.post('/auth/reset-password', { token, newPassword }),
        { fallback: 'Reset failed. Link may have expired.' })
      setSuccess(true)
      redirectTimer.current = setTimeout(() => navigate('/login'), 2000)
    } catch (_) { /* error already captured by useApi */ }
  }

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <Navbar />
      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm bg-white rounded-lg border border-gray-200 shadow-sm p-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-6">Set new password</h1>
          {success ? (
            <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-md px-3 py-2">
              Password reset! Redirecting to sign in…
            </p>
          ) : (
            <Form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <Input label="New password" type="password" value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                autoComplete="new-password" placeholder="Min. 8 characters" />
              <Input label="Confirm password" type="password" value={confirm}
                onChange={e => setConfirm(e.target.value)} autoComplete="new-password" />
              {error && <p className="text-sm text-red-600">{error}</p>}
              <Button type="submit" loading={loading} className="w-full">
                Reset password
              </Button>
            </Form>
          )}
        </div>
      </main>
      <Footer />
    </div>
  )
}
