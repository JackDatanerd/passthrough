import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import api from '../lib/api'
import { useApi } from '../hooks/useApi'
import { useAuth } from '../hooks/useAuth'
import Button from '../components/ui/Button'
import Form from '../components/ui/Form'
import Input from '../components/ui/Input'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'
import { passwordProblem } from '../lib/passwordRules'

export default function Register() {
  const navigate = useNavigate()
  const { postRegisterActions } = useAuth()
  const [name,     setName    ] = useState('')
  const [email,    setEmail   ] = useState('')
  const [password, setPassword] = useState('')
  const [confirm,  setConfirm ] = useState('')
  // FEATURE GAP CLOSED (Auth/Scan round): sign-up never asked for consent to
  // the Terms / Privacy Policy. The API requires it and records the version.
  const [acceptTerms, setAcceptTerms] = useState(false)
  const { loading, error, execute } = useApi()

  function fail(message) {
    return execute(() => Promise.reject(new Error(message)), { fallback: message }).catch(() => {})
  }

  async function handleSubmit() {
    if (!name || !email || !password) return fail('All fields required.')
    // FEATURE (Auth section, feature-gap-closing pass): was `.length < 8`
    // only — see passwordRules.js for why this now mirrors the server's
    // fuller rules instead of a person only finding out after submitting.
    const pwProblem = passwordProblem(password, email)
    if (pwProblem) return fail(pwProblem)
    if (password !== confirm) return fail('Passwords do not match.')
    if (!acceptTerms) return fail('Please accept the Terms of Service and Privacy Policy to continue.')
    try {
      await execute(async () => {
        const res = await api.post('/auth/register', { name: name.trim(), email: email.trim(), password, acceptTerms: true })
        const { token, user } = res.data.data
        const scanId = await postRegisterActions(token, user)
        // If there was a pending anon scan, go to it — otherwise dashboard
        navigate(scanId ? `/scan/${scanId}` : '/dashboard')
        return res
      }, { fallback: 'Registration failed.' })
    } catch (_) { /* error already captured by useApi */ }
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

            <label className="flex items-start gap-2 text-sm text-gray-600">
              <input type="checkbox" checked={acceptTerms} onChange={e => setAcceptTerms(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
              <span>
                I agree to the{' '}
                <Link to="/terms" target="_blank" className="text-blue-600 hover:underline">Terms of Service</Link>
                {' '}and{' '}
                <Link to="/privacy" target="_blank" className="text-blue-600 hover:underline">Privacy Policy</Link>.
              </span>
            </label>

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
