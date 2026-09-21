import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import api, { getErrorMessage } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import Button from '../components/ui/Button'
import Form from '../components/ui/Form'
import Input from '../components/ui/Input'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'

export default function Register() {
  const navigate = useNavigate()
  const { postRegisterActions } = useAuth()
  const [name,     setName    ] = useState('')
  const [email,    setEmail   ] = useState('')
  const [password, setPassword] = useState('')
  const [confirm,  setConfirm ] = useState('')
  const [loading,  setLoading ] = useState(false)
  const [error,    setError   ] = useState('')

  async function handleSubmit() {
    if (!name || !email || !password) return setError('All fields required.')
    if (password.length < 8) return setError('Password must be at least 8 characters.')
    if (password !== confirm) return setError('Passwords do not match.')
    setLoading(true); setError('')
    try {
      const res = await api.post('/auth/register', { name: name.trim(), email: email.trim(), password })
      const { token, user } = res.data.data
      const scanId = await postRegisterActions(token, user)
      // If there was a pending anon scan, go to it — otherwise dashboard
      navigate(scanId ? `/scan/${scanId}` : '/dashboard')
    } catch (err) {
      setError(getErrorMessage(err, 'Registration failed.'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <Navbar />
      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm bg-white rounded-lg border border-gray-200 shadow-sm p-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Create account</h1>
          <p className="text-sm text-gray-500 mb-6">Free. 3 scans per day. No credit card.</p>

          <Form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <Input label="Name" type="text" value={name}
              onChange={e => setName(e.target.value)} autoComplete="name" />
            <Input label="Email" type="email" value={email}
              onChange={e => setEmail(e.target.value)} autoComplete="email" />
            <Input label="Password" type="password" value={password}
              onChange={e => setPassword(e.target.value)} autoComplete="new-password"
              placeholder="Min. 8 characters" />
            <Input label="Confirm password" type="password" value={confirm}
              onChange={e => setConfirm(e.target.value)} autoComplete="new-password" />

            {error && <p className="text-sm text-red-600">{error}</p>}

            <Button type="submit" loading={loading} className="w-full">
              Create account
            </Button>
          </Form>

          <p className="mt-4 text-sm text-center text-gray-500">
            Already have an account?{' '}
            <Link to="/login" className="text-blue-600 hover:underline">Sign in</Link>
          </p>
        </div>
      </main>
      <Footer />
    </div>
  )
}
