import { useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../lib/api'
import { useApi } from '../hooks/useApi'
import Button from '../components/ui/Button'
import Form from '../components/ui/Form'
import Input from '../components/ui/Input'
import Textarea from '../components/ui/Textarea'
import Checkbox from '../components/ui/Checkbox'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'
import TurnstileWidget, { TURNSTILE_ENABLED } from '../components/lead/TurnstileWidget'
import { ATTRIBUTION_TERMS } from '../lib/partnerTerms'

// Public "become a partner" application. Reviewed by hand under Admin -> Partners;
// approval creates the partner and emails their payout-details link, so nothing
// here creates an account or reveals whether an address is already a partner.

export default function PartnerApply() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [website, setWebsite] = useState('')
  const [audience, setAudience] = useState('')
  const [message, setMessage] = useState('')
  const [company, setCompany] = useState('')   // honeypot — humans never see it
  // Round 6: applying records acceptance of the program terms (/partner/terms); the server requires it.
  const [accepted, setAccepted] = useState(false)
  const [sent, setSent] = useState(false)
  // Cloudflare Turnstile (opt-in: renders nothing and demands nothing unless the site key is set).
  const [captcha, setCaptcha] = useState('')
  const [captchaReset, setCaptchaReset] = useState(0)
  const { loading, error, execute } = useApi()

  async function handleSubmit() {
    if (!name.trim() || !email.trim()) {
      await execute(() => Promise.reject(new Error('Please enter your name and email.')),
        { fallback: 'Please enter your name and email.' }).catch(() => {})
      return
    }
    if (!accepted) {
      await execute(() => Promise.reject(new Error('Please accept the partner program terms to apply.')),
        { fallback: 'Please accept the partner program terms to apply.' }).catch(() => {})
      return
    }
    if (TURNSTILE_ENABLED && !captcha) {
      await execute(() => Promise.reject(new Error('Please complete the security check below.')),
        { fallback: 'Please complete the security check below.' }).catch(() => {})
      return
    }
    try {
      await execute(() => api.post('/partners/apply', {
        name: name.trim(), email: email.trim(), acceptTerms: true,
        ...(website.trim() ? { website: website.trim() } : {}),
        ...(audience.trim() ? { audience: audience.trim() } : {}),
        ...(message.trim() ? { message: message.trim() } : {}),
        ...(company ? { company } : {}),
        ...(captcha ? { turnstileToken: captcha } : {}),
      }), { fallback: 'Something went wrong — please try again.' })
      setSent(true)
    } catch (_) {
      // error already captured by useApi. A Turnstile token is single-use, so the next try needs a fresh one.
      setCaptcha(''); setCaptchaReset(n => n + 1)
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <Navbar />
      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-lg bg-white rounded-lg border border-gray-200 shadow-sm p-8">
          {sent ? (
            <div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">Application received ✓</h1>
              <p className="text-sm text-gray-600">
                Thanks, {name.trim()} — we've emailed a confirmation to {email.trim()}, and we'll email you again once we've reviewed it.
              </p>
            </div>
          ) : (
            <>
              <h1 className="text-xl font-bold text-gray-900 mb-1">Become a Passthrough partner</h1>
              <p className="text-sm text-gray-500 mb-6">
                Share Passthrough with your audience and earn commission on every sale made through your link.
                Tell us a bit about you — we review every application by hand.
              </p>
              <div className="mb-6 rounded-md bg-gray-50 border border-gray-200 px-4 py-3" data-testid="attribution-terms">
                <p className="text-xs font-semibold text-gray-700 mb-1">How crediting works</p>
                <ul className="list-disc pl-4 text-xs text-gray-600 space-y-1">
                  {ATTRIBUTION_TERMS.map(t => <li key={t}>{t}</li>)}
                </ul>
              </div>
              <Form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <Input label="Your name" value={name} onChange={e => setName(e.target.value)} maxLength={200} />
                <Input label="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} maxLength={320} />
                <Input label="Website or social profile (optional)" value={website} onChange={e => setWebsite(e.target.value)} maxLength={300} />
                <Textarea label="Who would you share it with? (optional)" value={audience} onChange={e => setAudience(e.target.value)} maxLength={1000} rows={3} />
                <Textarea label="Anything else? (optional)" value={message} onChange={e => setMessage(e.target.value)} maxLength={2000} rows={3} />
                {/* Honeypot: off-screen, not tabbable, not announced. */}
                <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', height: 0, overflow: 'hidden' }}>
                  <label>Company <input tabIndex={-1} autoComplete="off" value={company} onChange={e => setCompany(e.target.value)} /></label>
                </div>
                <Checkbox
                  checked={accepted} onChange={e => setAccepted(e.target.checked)}
                  wrapperClassName="items-start"
                  label={<span>I have read and accept the <Link to="/partner/terms" target="_blank" rel="noopener" className="text-blue-700 hover:underline">partner program terms</Link>.</span>}
                />
                <TurnstileWidget onToken={setCaptcha} resetSignal={captchaReset} />
                {error && <p className="text-sm text-red-600">{error}</p>}
                <Button type="submit" loading={loading} className="w-full">Submit application</Button>
              </Form>
            </>
          )}
        </div>
      </main>
      <Footer />
    </div>
  )
}
