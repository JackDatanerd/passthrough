import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import api, { getErrorMessage } from '../lib/api'
import Spinner from '../components/ui/Spinner'
import Button from '../components/ui/Button'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'

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
    body: 'This address is already confirmed. There is nothing more to do.' },
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
  const ran = useRef(false)

  async function run() {
    setState(isConfirm ? 'loading' : 'working')
    try {
      const res = await api.post(`/employer-leads/${mode}`, { token })
      setResult(res.data.status || 'removed')
      setState('done')
    } catch (err) {
      setMessage(getErrorMessage(err, 'This link could not be processed. Please try again.'))
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
              <Link to="/" className="text-sm text-blue-600 hover:underline">Back to Passthrough</Link>
            </>
          )}
        </div>
      </main>
      <Footer />
    </div>
  )
}
