import { useState } from 'react'
import { Link } from 'react-router-dom'
import api, { getErrorMessage } from '../lib/api'
import Button from '../components/ui/Button'
import Form from '../components/ui/Form'
import Input from '../components/ui/Input'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'

export default function ForgotPassword() {
  const [email,   setEmail  ] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent,    setSent   ] = useState(false)
  const [error,   setError  ] = useState('')

  async function handleSubmit() {
    if (!email) return setError('Email required.')
    setLoading(true); setError('')
    try {
      await api.post('/auth/forgot-password', { email: email.trim() })
      setSent(true)
    } catch (err) {
      // The server answers 200 whether or not the email is registered (so
      // this can't be used to probe for accounts) — which means an ERROR here
      // is never "unknown email". It's a rate limit, a bad address, an outage
      // or a dead network, and claiming "check your inbox" for those left
      // people waiting on an email that was never sent.
      setError(getErrorMessage(err, "Couldn't send the reset link. Please try again."))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <Navbar />
      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm bg-white rounded-lg border border-gray-200 shadow-sm p-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Reset password</h1>
          {sent ? (
            <div>
              <p className="text-sm text-gray-600 mb-4">
                If that email is registered, check your inbox for a reset link.
              </p>
              <Link to="/login" className="text-sm text-blue-600 hover:underline">
                Back to sign in
              </Link>
            </div>
          ) : (
            <>
              <p className="text-sm text-gray-500 mb-6">
                Enter your email and we'll send a reset link.
              </p>
              <Form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <Input label="Email" type="email" value={email}
                  onChange={e => setEmail(e.target.value)} autoComplete="email" />
                {error && <p className="text-sm text-red-600">{error}</p>}
                <Button type="submit" loading={loading} className="w-full">
                  Send reset link
                </Button>
              </Form>
              <p className="mt-4 text-sm text-center">
                <Link to="/login" className="text-blue-600 hover:underline">Back to sign in</Link>
              </p>
            </>
          )}
        </div>
      </main>
      <Footer />
    </div>
  )
}
