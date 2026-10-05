import { useState } from 'react'
import api from '../lib/api'
import { useApi } from '../hooks/useApi'
import Button from '../components/ui/Button'
import Form from '../components/ui/Form'
import Input from '../components/ui/Input'
import Textarea from '../components/ui/Textarea'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'

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
  const [sent, setSent] = useState(false)
  const { loading, error, execute } = useApi()

  async function handleSubmit() {
    if (!name.trim() || !email.trim()) {
      await execute(() => Promise.reject(new Error('Please enter your name and email.')),
        { fallback: 'Please enter your name and email.' }).catch(() => {})
      return
    }
    try {
      await execute(() => api.post('/partners/apply', {
        name: name.trim(), email: email.trim(),
        ...(website.trim() ? { website: website.trim() } : {}),
        ...(audience.trim() ? { audience: audience.trim() } : {}),
        ...(message.trim() ? { message: message.trim() } : {}),
        ...(company ? { company } : {}),
      }), { fallback: 'Something went wrong — please try again.' })
      setSent(true)
    } catch (_) { /* error already captured by useApi */ }
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
                Thanks, {name.trim()} — we'll review it and email you at {email.trim()} once we have.
              </p>
            </div>
          ) : (
            <>
              <h1 className="text-xl font-bold text-gray-900 mb-1">Become a Passthrough partner</h1>
              <p className="text-sm text-gray-500 mb-6">
                Share Passthrough with your audience and earn commission on every sale made through your link.
                Tell us a bit about you — we review every application by hand.
              </p>
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
