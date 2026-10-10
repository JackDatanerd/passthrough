import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import api, { getErrorMessage } from '../lib/api'
import Spinner from '../components/ui/Spinner'
import Button from '../components/ui/Button'
import Input from '../components/ui/Input'
import Select from '../components/ui/Select'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'
import { ROLE_CATEGORIES } from '../lib/roleCategories'

// /employer/rejoin?token=… — the link in the email sent to someone who removed their address
// earlier and later typed it into the public form again. Nothing happens until they press the
// button (mail scanners open links), and the form asks for the details again because removal
// deleted them.
const RESULT_COPY = {
  joined:      { icon: '✓', tone: 'text-green-500', title: "You're back on the list",
    body: "You're back on the list. We'll email you when there are Verified candidates in your field." },
  already:     { icon: '✓', tone: 'text-green-500', title: "You're already on the list",
    body: "You're already on the list — nothing more to do." },
  unavailable: { icon: '–', tone: 'text-gray-400', title: "Can't add this address",
    body: "This address can't be added back from here. Contact support@passthrough.dev." },
}

export default function EmployerLeadRejoin() {
  const [params] = useSearchParams()
  const token = params.get('token')
  const [state, setState] = useState(token ? 'ask' : 'error') // ask | working | done | error
  const [result, setResult] = useState(null)
  const [message, setMessage] = useState(token ? '' : 'This link is missing its token. Use the link from the email we sent you.')
  const [retryable, setRetryable] = useState(false)
  const [name, setName] = useState('')
  const [company, setCompany] = useState('')
  const [field, setField] = useState('')
  const [formError, setFormError] = useState('')

  async function submit() {
    if (!name.trim() || !company.trim()) return setFormError('Name and company are required.')
    setFormError('')
    setState('working')
    try {
      const res = await api.post('/employer-leads/rejoin', {
        token, name: name.trim(), company: company.trim(), ...(field ? { field } : {}),
      })
      setResult(res.data.status in RESULT_COPY ? res.data.status : 'joined')
      setState('done')
    } catch (err) {
      setMessage(getErrorMessage(err, 'This link could not be processed. Please try again.'))
      setRetryable(err?.response?.status !== 400)
      setState('error')
    }
  }

  const copy = RESULT_COPY[result]

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <Navbar />
      <main className="flex-1 flex items-center justify-center px-4">
        <div className="w-full max-w-sm bg-white rounded-lg border border-gray-200 shadow-sm p-8 text-center">
          {state === 'working' && (
            <>
              <Spinner size="lg" className="mx-auto mb-4" />
              <p className="text-gray-600">Adding you back…</p>
            </>
          )}
          {state === 'ask' && (
            <>
              <h1 className="text-xl font-bold text-gray-900 mb-2">Join the list again?</h1>
              <p className="text-sm text-gray-500 mb-6">
                You removed your address earlier. Tell us who you are and we'll add you back.
              </p>
              <form onSubmit={e => { e.preventDefault(); submit() }} className="flex flex-col gap-3 text-left">
                <Input label="Name" value={name} onChange={e => setName(e.target.value)} autoComplete="name" />
                <Input label="Company" value={company} onChange={e => setCompany(e.target.value)} autoComplete="organization" />
                <Select id="rejoin-field" label="Field (optional)" value={field} onChange={e => setField(e.target.value)}>
                  <option value="">Choose a field…</option>
                  {ROLE_CATEGORIES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                </Select>
                {formError && <p role="alert" className="text-sm text-red-600">{formError}</p>}
                <Button type="submit" className="w-full">Add me back to the list</Button>
              </form>
              <div className="mt-4"><Link to="/" className="text-sm text-blue-600 hover:underline">No thanks</Link></div>
            </>
          )}
          {state === 'done' && copy && (
            <>
              <div className={`${copy.tone} text-4xl mb-3`}>{copy.icon}</div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">{copy.title}</h1>
              <p className="text-sm text-gray-500 mb-6">{copy.body}</p>
              <Link to="/" className="text-sm text-blue-600 hover:underline">Back to Passthrough</Link>
            </>
          )}
          {state === 'error' && (
            <>
              <div className="text-red-500 text-4xl mb-3">✕</div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">Could not add you back</h1>
              <p className="text-sm text-gray-500 mb-6">{message}</p>
              {retryable && token && <Button onClick={() => setState('ask')} className="mb-4">Try again</Button>}
              <div><Link to="/" className="text-sm text-blue-600 hover:underline">Back to Passthrough</Link></div>
            </>
          )}
        </div>
      </main>
      <Footer />
    </div>
  )
}
