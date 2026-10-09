import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import api from '../lib/api'
import { useApi } from '../hooks/useApi'
import Button from '../components/ui/Button'
import Form from '../components/ui/Form'
import Input from '../components/ui/Input'
import TurnstileWidget, { TURNSTILE_ENABLED } from '../components/lead/TurnstileWidget'
import { useCooldown } from '../hooks/useCooldown'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'

export default function ForgotPassword() {
  // Login's "Forgot password?" link carries whatever was typed there.
  const [params] = useSearchParams()
  const [email, setEmail] = useState(() => (params.get('email') || '').slice(0, 254))
  const [sent,  setSent ] = useState(false)
  const [captcha, setCaptcha] = useState('')
  const [captchaReset, setCaptchaReset] = useState(0)
  // The server throttles reset emails per address; a visible timer beats a bare "Too many attempts".
  const { remaining, start: startCooldown } = useCooldown(30)
  const { loading, error, execute } = useApi()

  async function handleSubmit() {
    if (!email) {
      await execute(() => Promise.reject(new Error('Email required.')), { fallback: 'Email required.' }).catch(() => {})
      return
    }
    if (TURNSTILE_ENABLED && !captcha) {
      await execute(() => Promise.reject(new Error('Please complete the security check below.')),
        { fallback: 'Please complete the security check below.' }).catch(() => {})
      return
    }
    try {
      // The server answers 200 whether or not the email is registered (so
      // this can't be used to probe for accounts) — which means an ERROR here
      // is never "unknown email". It's a rate limit, a bad address, an outage
      // or a dead network, and claiming "check your inbox" for those left
      // people waiting on an email that was never sent.
      await execute(() => api.post('/auth/forgot-password', { email: email.trim(), turnstileToken: captcha || undefined }),
        { fallback: "Couldn't send the reset link. Please try again." })
      setSent(true)
      startCooldown()
      setCaptcha(''); setCaptchaReset(n => n + 1)   // a Turnstile token is single-use
    } catch (_) {
      setCaptcha(''); setCaptchaReset(n => n + 1)
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
              <div className="flex items-center justify-between">
                <Link to="/login" className="text-sm text-blue-600 hover:underline">
                  Back to sign in
                </Link>
                {/* Typo'd the address? Without this the only way back to the form
                    was a page reload. The server answers the same either way. */}
                <button type="button" onClick={() => setSent(false)}
                  className="text-sm text-blue-600 hover:underline">
                  Use a different email
                </button>
              </div>
              <div className="mt-4 text-center">
                {/* With the challenge on, a fresh one is needed for every send, so go back to the form. */}
                <button type="button" onClick={TURNSTILE_ENABLED ? () => setSent(false) : handleSubmit} disabled={loading || remaining > 0}
                  className="text-sm text-blue-600 hover:underline disabled:text-gray-400 disabled:no-underline">
                  {remaining > 0 ? `Send again in ${remaining}s` : 'Send the link again'}
                </button>
                {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
              </div>
            </div>
          ) : (
            <>
              <p className="text-sm text-gray-500 mb-6">
                Enter your email and we'll send a reset link.
              </p>
              <Form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <Input label="Email" type="email" value={email}
                  onChange={e => setEmail(e.target.value)} autoComplete="email" />
                <TurnstileWidget onToken={setCaptcha} resetSignal={captchaReset} />
                {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
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
