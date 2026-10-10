import { useState } from 'react'
import Button from '../ui/Button'
import Input from '../ui/Input'
import Form from '../ui/Form'
import api, { getErrorMessage } from '../../lib/api'
import { RoleFields, LeadConsentNote, LEAD_SENT_MESSAGE } from './LeadFormParts'
import TurnstileWidget, { TURNSTILE_ENABLED } from './TurnstileWidget'

// FEATURE GAP CLOSED (Section 5 — Employer leads): the only place a hiring
// manager could ever actually submit a lead was buried at the bottom of an
// individual candidate's Verify.jsx page — reachable only if they already
// had a specific verification link. This homepage section is the actual
// top-of-funnel pitch ("For employers & hiring managers", linked from the
// Navbar and Footer as "For employers"), and until now it was pure copy
// with no way to act on it at all. Mirrors Verify.jsx's lead form (same
// fields, same endpoint) — source is 'homepage' so admin can tell the two
// entry points apart in the leads list.
export default function EmployerLeadForm() {
  const [name,    setName   ] = useState('')
  const [company, setCompany] = useState('')
  const [email,   setEmail  ] = useState('')
  const [field,   setField  ] = useState('')
  const [title,   setTitle  ] = useState('')
  const [trap, setTrap] = useState('')  // honeypot — real visitors never see or fill this (see the API's `trap` field)
  const [sent,    setSent   ] = useState(false)
  const [err,     setErr    ] = useState('')
  const [loading, setLoading] = useState(false)
  const [captcha, setCaptcha] = useState('')
  const [captchaReset, setCaptchaReset] = useState(0)

  async function handleSubmit(e) {
    e?.preventDefault?.()
    if (!name || !company || !email) return setErr('Name, company, and email required.')
    if (TURNSTILE_ENABLED && !captcha) return setErr('Please complete the verification check below.')
    setLoading(true); setErr('')
    try {
      await api.post('/employer-leads', {
        name, company, email, roleCategory: field || undefined, roleTitle: title || undefined,
        source: 'homepage', trap, turnstileToken: captcha || undefined
      })
      setSent(true)
    } catch (e) {
      setErr(getErrorMessage(e, 'Something went wrong.'))
      setCaptcha(''); setCaptchaReset(n => n + 1)   // a token is single-use
    } finally {
      setLoading(false)
    }
  }

  if (sent) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 sm:p-8 text-center">
        <p className="text-sm text-green-700 font-medium">{LEAD_SENT_MESSAGE}</p>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 sm:p-8">
      <h3 className="font-semibold text-gray-900 mb-1">Get early access to Verified candidates</h3>
      <p className="text-sm text-gray-500 mb-4">We'll reach out when we have candidates matching your needs.</p>
      <Form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <Input aria-label="Your name" autoComplete="name" placeholder="Your name" value={name} onChange={e => setName(e.target.value)} />
        <Input aria-label="Company" autoComplete="organization" placeholder="Company" value={company} onChange={e => setCompany(e.target.value)} />
        <Input aria-label="Work email" autoComplete="email" type="email" placeholder="Work email" value={email} onChange={e => setEmail(e.target.value)} />
        <RoleFields category={field} onCategory={setField} title={title} onTitle={setTitle} />
        <LeadConsentNote />
        <TurnstileWidget onToken={setCaptcha} resetSignal={captchaReset} />
        {err && <p role="alert" className="text-xs text-red-600">{err}</p>}
        {/* Honeypot: invisible to a real person, tempting to a bot filling every
            field it finds. Off-screen rather than display:none/hidden — some
            bots skip fields a screen reader would also skip. */}
        <input type="text" name="lead_ref_code" value={trap} onChange={e => setTrap(e.target.value)}
          tabIndex={-1} autoComplete="off" aria-hidden="true" data-lpignore="true" data-1p-ignore="true" data-form-type="other"
          style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }} />
        <Button type="submit" loading={loading}>Get early access</Button>
      </Form>
    </div>
  )
}
