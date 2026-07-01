import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import api from '../lib/api'
import Button from '../components/ui/Button'
import Input from '../components/ui/Input'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'

export default function ResetPassword() {
  const navigate  = useNavigate()
  const [params]  = useSearchParams()
  const token     = params.get('token')
  const [newPassword, setNewPassword] = useState('')
  const [confirm,     setConfirm    ] = useState('')
  const [loading,     setLoading    ] = useState(false)
  const [error,       setError      ] = useState('')
  const [success,     setSuccess    ] = useState(false)

  if (!token) {
    return (
      <div className="min-h-screen flex flex-col bg-gray-50">
        <Navbar />
        <main className="flex-1 flex items-center justify-center px-4">
          <div className="text-center">
            <p className="text-gray-600 mb-4">Invalid or missing reset link.</p>
            <Link to="/forgot-password" className="text-blue-600 hover:underline text-sm">
              Request a new one
            </Link>
          </div>
        </main>
        <Footer />
      </div>
    )
  }

  async function handleSubmit() {
    if (!newPassword) return setError('Password required.')
    if (newPassword.length < 8) return setError('Password must be at least 8 characters.')
    if (newPassword !== confirm) return setError('Passwords do not match.')
    setLoading(true); setError('')
    try {
      await api.post('/auth/reset-password', { token, newPassword })
      setSuccess(true)
      setTimeout(() => navigate('/login'), 2000)
    } catch (err) {
      setError(err.response?.data?.message || 'Reset failed. Link may have expired.')
    } finally {
      setLoading(false)
    }
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
            <div className="flex flex-col gap-4">
              <Input label="New password" type="password" value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                autoComplete="new-password" placeholder="Min. 8 characters" />
              <Input label="Confirm password" type="password" value={confirm}
                onChange={e => setConfirm(e.target.value)} autoComplete="new-password" />
              {error && <p className="text-sm text-red-600">{error}</p>}
              <Button onClick={handleSubmit} loading={loading} className="w-full">
                Reset password
              </Button>
            </div>
          )}
        </div>
      </main>
      <Footer />
    </div>
  )
}
