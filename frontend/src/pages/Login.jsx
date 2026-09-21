import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import api, { getErrorMessage } from '../lib/api'
import { safeNext } from '../lib/session'
import { useAuth } from '../hooks/useAuth'
import Button from '../components/ui/Button'
import Form from '../components/ui/Form'
import Input from '../components/ui/Input'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'

export default function Login() {
  const navigate        = useNavigate()
  const [params]        = useSearchParams()
  const { postAuthActions } = useAuth()
  const [email,    setEmail   ] = useState('')
  const [password, setPassword] = useState('')
  const [loading,  setLoading ] = useState(false)
  const [error,    setError   ] = useState('')

  const expired = params.get('expired') === 'true'
  const banned  = params.get('banned')  === 'true'
  // Where to go after signing in (set when a protected page bounced the user
  // here). safeNext() rejects anything that isn't a same-site relative path.
  const next    = safeNext(params.get('next'))

  async function handleSubmit() {
    if (!email || !password) return setError('Email and password required.')
    setLoading(true); setError('')
    try {
      const res = await api.post('/auth/login', { email: email.trim(), password })
      const { token, user } = res.data.data
      // Also claims a pending anonymous scan, exactly like registering does.
      const claimedScanId = await postAuthActions(token, user)
      navigate(next || (claimedScanId ? `/scan/${claimedScanId}` : '/dashboard'))
    } catch (err) {
      setError(getErrorMessage(err, 'Login failed.'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <Navbar />
      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm bg-white rounded-lg border border-gray-200 shadow-sm p-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-6">Sign in</h1>

          {expired && (
            <div className="mb-4 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
              Your session expired. Please sign in again.
            </div>
          )}
          {banned && (
            <div className="mb-4 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-800">
              Your account has been suspended.
            </div>
          )}

          <Form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <Input label="Email" type="email" value={email}
              onChange={e => setEmail(e.target.value)} autoComplete="email" />
            <Input label="Password" type="password" value={password}
              onChange={e => setPassword(e.target.value)} autoComplete="current-password" />

            {error && <p className="text-sm text-red-600">{error}</p>}

            <Button type="submit" loading={loading} className="w-full">
              Sign in
            </Button>
          </Form>

          <div className="mt-4 flex flex-col gap-2 text-sm text-center text-gray-500">
            <Link to="/forgot-password" className="text-blue-600 hover:underline">
              Forgot password?
            </Link>
            <p>No account? <Link to="/register" className="text-blue-600 hover:underline">Get started free</Link></p>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  )
}
