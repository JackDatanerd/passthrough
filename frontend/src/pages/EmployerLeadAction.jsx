import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import api, { getErrorMessage } from '../lib/api'
import Spinner from '../components/ui/Spinner'
import Button from '../components/ui/Button'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'
import { ROLE_CATEGORIES } from '../lib/roleCategories'

// The two pages the links in the employer early-access email land on:
//   /employer/confirm?token=…  — confirms the address is theirs (runs on load:
//                                harmless, it only sets a timestamp)
//   /employer/remove?token=…   — removes the address for good. Deliberately
//                                needs a button press: mail scanners and link
//                                previewers open links (some run scripts), and
//                                an unsubscribe that fired on load would
//                                remove people who never asked.
// The token is a signed, stateless proof of the address (see the backend's
// lib/leadTokens.js); no login is involved.
const CONFIRM_COPY = {
  confirmed:  { icon: '✓', tone: 'text-green-500', title: 'Email confirmed',
    body: "Thanks — we'll email you when there are Verified candidates in your field." },
  already:    { icon: '✓', tone: 'text-green-500', title: 'Already confirmed',
    body: 'This address is already confirmed.' },
  not_found:  { icon: '–', tone: 'text-gray-400', title: 'Nothing to confirm',
    body: 'We no longer have a request for this address. If you still want early access, you can sign up again.' },
}

export default function EmployerLeadAction({ mode }) {
  const [params] = useSearchParams()
  const token = params.get('token')
  const isConfirm = mode === 'confirm'
  const [state, setState] = useState(token ? (isConfirm ? 'loading' : 'ask') : 'error') // loading | ask | working | done | error
  const [result, setResult] = useState(null)
  const [message, setMessage] = useState(token ? '' : 'This link is missing its token. Use the link from the email we sent you.')
  // A rejected link (400) will never work on a second try; a network or server hiccup might.
  const [retryable, setRetryable] = useState(false)
  const ran = useRef(false)
  // The confirm response says when the lead never named a field — without one they can never be
  // matched with candidates, so the confirmed screen asks (same signed token, no login).
  const [needsField, setNeedsField] = useState(false)
  const [field, setField] = useState('')
  const [fieldState, setFieldState] = useState('idle') // idle | saving | saved | error
  const [fieldError, setFieldError] = useState('')

  async function saveField() {
    if (!field) return
    setFieldState('saving'); setFieldError('')
    try {
      const res = await api.post('/employer-leads/field', { token, field })
      if (res.data.status === 'not_found') { setNeedsField(false); setResult('not_found') }
      else setFieldState('saved')
    } catch (err) {
      setFieldError(getErrorMessage(err, 'Could not save that. Please try again.'))
      setFieldState('error')
    }
  }

  async function run() {
    setState(isConfirm ? 'loading' : 'working')
    try {
      const res = await api.post(`/employer-leads/${mode}`, { token })
      setResult(res.data.status || 'removed')
      setNeedsField(isConfirm && !!res.data.needsField)
      setState('done')
    } catch (err) {
      setMessage(getErrorMessage(err, 'This link could not be processed. Please try again.'))
      setRetryable(!!token && err?.response?.status !== 400)
      setState('error')
    }
  }

  useEffect(() => {
    if (!isConfirm || !token || ran.current) return   // StrictMode double-invoke guard
    ran.current = true
    run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const copy = isConfirm ? (CONFIRM_COPY[result] || CONFIRM_COPY.confirmed) : null

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <Navbar />
      <main className="flex-1 flex items-center justify-center px-4">
        <div className="w-full max-w-sm bg-white rounded-lg border border-gray-200 shadow-sm p-8 text-center">
          {(state === 'loading' || state === 'working') && (
            <>
              <Spinner size="lg" className="mx-auto mb-4" />
              <p className="text-gray-600">{isConfirm ? 'Confirming your email…' : 'Removing your address…'}</p>
            </>
          )}
          {state === 'ask' && (
            <>
              <h1 className="text-xl font-bold text-gray-900 mb-2">Remove your email?</h1>
              <p className="text-sm text-gray-500 mb-6">
                We'll delete your early-access request and won't contact you again.
              </p>
              <div className="flex flex-col gap-2">
                <Button onClick={run}>Yes, remove me</Button>
                <Link to="/" className="text-sm text-blue-600 hover:underline">No, keep me on the list</Link>
              </div>
            </>
          )}
          {state === 'done' && isConfirm && (
            <>
              <div className={`${copy.tone} text-4xl mb-3`}>{copy.icon}</div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">{copy.title}</h1>
              <p className="text-sm text-gray-500 mb-6">{copy.body}</p>
              {needsField && fieldState !== 'saved' && (
                <div className="mb-6 text-left">
                  <label htmlFor="lead-field" className="block text-sm font-medium text-gray-700 mb-1">
                    Which field are you hiring in?
                  </label>
                  <select id="lead-field" value={field} onChange={e => setField(e.target.value)}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm mb-2">
                    <option value="">Choose a field…</option>
                    {ROLE_CATEGORIES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                  </select>
                  {fieldState === 'error' && <p role="alert" className="text-xs text-red-600 mb-2">{fieldError}</p>}
                  <Button onClick={saveField} disabled={!field || fieldState === 'saving'} className="w-full">
                    {fieldState === 'saving' ? 'Saving…' : 'Save'}
                  </Button>
                </div>
              )}
              {fieldState === 'saved' && (
                <p className="text-sm text-green-600 mb-6">Saved — we'll email you when there are Verified candidates in that field.</p>
              )}
              <Link to="/" className="text-sm text-blue-600 hover:underline">Back to Passthrough</Link>
            </>
          )}
          {state === 'done' && !isConfirm && (
            <>
              <div className="text-green-500 text-4xl mb-3">✓</div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">You've been removed</h1>
              <p className="text-sm text-gray-500 mb-6">We won't contact you again.</p>
              <Link to="/" className="text-sm text-blue-600 hover:underline">Back to Passthrough</Link>
            </>
          )}
          {state === 'error' && (
            <>
              <div className="text-red-500 text-4xl mb-3">✕</div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">{isConfirm ? 'Confirmation failed' : 'Removal failed'}</h1>
              <p className="text-sm text-gray-500 mb-6">{message}</p>
              {retryable && <Button onClick={run} className="mb-4">Try again</Button>}
              <div><Link to="/" className="text-sm text-blue-600 hover:underline">Back to Passthrough</Link></div>
            </>
          )}
        </div>
      </main>
      <Footer />
    </div>
  )
}
