import { useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../lib/api'
import { useApi } from '../hooks/useApi'
import Button from '../components/ui/Button'
import Form from '../components/ui/Form'
import Input from '../components/ui/Input'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'
import TurnstileWidget, { TURNSTILE_ENABLED } from '../components/lead/TurnstileWidget'

// "I lost my link" — a partner who deleted their emails can ask for their read-only dashboard link to be sent
// again to the address on file. The answer is the same whether or not the address belongs to a partner, so this
// page can't be used to find out who is one (Section 4 round 7).

export default function PartnerRecover() {
  const [email, setEmail] = useState('')
  const [company, setCompany] = useState('')   // honeypot — humans never see it
  const [sent, setSent] = useState(false)
  const [captcha, setCaptcha] = useState('')
  const [captchaReset, setCaptchaReset] = useState(0)
  const { loading, error, execute } = useApi()

  async function handleSubmit() {
    if (!email.trim()) {
      await execute(() => Promise.reject(new Error('Please enter your email.')), { fallback: 'Please enter your email.' }).catch(() => {})
      return
    }
    if (TURNSTILE_ENABLED && !captcha) {
      await execute(() => Promise.reject(new Error('Please complete the security check below.')),
        { fallback: 'Please complete the security check below.' }).catch(() => {})
      return
    }
    try {
      await execute(() => api.post('/partners/recover-links', {
        email: email.trim(),
        ...(company ? { company } : {}),
        ...(captcha ? { turnstileToken: captcha } : {}),
      }), { fallback: 'Something went wrong — please try again.' })
      setSent(true)
    } catch (_) {
      // A Turnstile token is single-use, so the next try needs a fresh one.
      setCaptcha(''); setCaptchaReset(n => n + 1)
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <Navbar />
      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md bg-white rounded-lg border border-gray-200 shadow-sm p-8">
          {sent ? (
            <div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">Check your inbox</h1>
              <p className="text-sm text-gray-600" data-testid="recover-sent">
                If {email.trim()} belongs to a Passthrough partner, we've emailed their dashboard link to it.
                It can take a few minutes — check your spam folder too.
              </p>
            </div>
          ) : (
            <>
              <h1 className="text-xl font-bold text-gray-900 mb-1">Lost your partner link?</h1>
              <p className="text-sm text-gray-500 mb-6">
                Enter the email address you signed up with and we'll send your dashboard link to it again.
                Not a partner yet? <Link to="/partner/apply" className="text-blue-700 hover:underline">Apply here</Link>.
              </p>
              <Form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <Input label="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} maxLength={320} />
                {/* Honeypot: off-screen, not tabbable, not announced. */}
                <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', height: 0, overflow: 'hidden' }}>
                  <label>Company <input tabIndex={-1} autoComplete="off" value={company} onChange={e => setCompany(e.target.value)} /></label>
                </div>
                <TurnstileWidget onToken={setCaptcha} resetSignal={captchaReset} />
                {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
                <Button type="submit" loading={loading} className="w-full">Email me my link</Button>
              </Form>
            </>
          )}
        </div>
      </main>
      <Footer />
    </div>
  )
}
