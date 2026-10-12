import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import api, { getErrorMessage } from '../lib/api'
import Spinner from '../components/ui/Spinner'
import Button from '../components/ui/Button'
import Input from '../components/ui/Input'
import Checkbox from '../components/ui/Checkbox'
import Select from '../components/ui/Select'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'
import { ROLE_CATEGORIES } from '../lib/roleCategories'

// /employer/preferences?token=… — the "update my details" link in the acknowledgement and candidates emails.
// The signed token proves the inbox is theirs; this lets them correct the field, the other fields they hire in and
// the job title on their own lead. It never changes name, company or status.
const MAX_EXTRA_FIELDS = 4

export default function EmployerLeadPreferences() {
  const [params] = useSearchParams()
  const token = params.get('token')
  const [state, setState] = useState(token ? 'loading' : 'error') // loading | edit | saving | saved | gone | error
  const [message, setMessage] = useState(token ? '' : 'This link is missing its token. Use the link from the email we sent you.')
  const [field, setField] = useState('')
  const [extras, setExtras] = useState([])
  const [roleTitle, setRoleTitle] = useState('')
  const [formError, setFormError] = useState('')

  useEffect(() => {
    if (!token) return
    let live = true
    api.post('/employer-leads/preferences/load', { token }).then(res => {
      if (!live) return
      if (res.data.status === 'not_found') return setState('gone')
      const d = res.data.data || {}
      setField(d.field || '')
      setExtras(Array.isArray(d.extraFields) ? d.extraFields : [])
      setRoleTitle(d.roleTitle || '')
      setState('edit')
    }).catch(err => {
      if (!live) return
      setMessage(getErrorMessage(err, 'This link could not be processed. Please try again.'))
      setState('error')
    })
    return () => { live = false }
  }, [token])

  const toggle = (key) => setExtras(cur => cur.includes(key) ? cur.filter(k => k !== key) : cur.length >= MAX_EXTRA_FIELDS ? cur : [...cur, key])

  async function save() {
    if (!field) return setFormError('Choose your main field.')
    setFormError('')
    setState('saving')
    try {
      const res = await api.post('/employer-leads/preferences', {
        token, field, extraFields: extras.filter(k => k !== field), roleTitle: roleTitle.trim() || null,
      })
      setState(res.data.status === 'not_found' ? 'gone' : 'saved')
    } catch (err) {
      setFormError(getErrorMessage(err, 'Could not save. Please try again.'))
      setState('edit')
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <Navbar />
      <main className="flex-1 flex items-center justify-center px-4">
        <div className="w-full max-w-md bg-white rounded-lg border border-gray-200 shadow-sm p-8 text-center">
          {(state === 'loading' || state === 'saving') && (
            <>
              <Spinner size="lg" className="mx-auto mb-4" />
              <p className="text-gray-600">{state === 'loading' ? 'Loading your details…' : 'Saving…'}</p>
            </>
          )}
          {state === 'edit' && (
            <>
              <h1 className="text-xl font-bold text-gray-900 mb-2">Update your details</h1>
              <p className="text-sm text-gray-500 mb-6">We use these to tell you when there are Verified candidates in your fields.</p>
              <form onSubmit={e => { e.preventDefault(); save() }} className="flex flex-col gap-4 text-left">
                <Select id="prefs-field" label="Main field" value={field} onChange={e => setField(e.target.value)}>
                  <option value="">Choose a field…</option>
                  {ROLE_CATEGORIES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                </Select>
                <fieldset>
                  <legend className="text-sm font-medium text-gray-700 mb-1">Also hiring in (up to {MAX_EXTRA_FIELDS})</legend>
                  <div className="grid grid-cols-2 gap-1">
                    {ROLE_CATEGORIES.filter(([key]) => key !== field).map(([key, label]) => (
                      <Checkbox key={key} label={label} checked={extras.includes(key)} onChange={() => toggle(key)}
                        disabled={!extras.includes(key) && extras.length >= MAX_EXTRA_FIELDS} />
                    ))}
                  </div>
                </fieldset>
                <Input label="Job title (optional)" value={roleTitle} onChange={e => setRoleTitle(e.target.value)} maxLength={100} />
                {formError && <p role="alert" className="text-sm text-red-600">{formError}</p>}
                <Button type="submit" className="w-full">Save</Button>
              </form>
            </>
          )}
          {state === 'saved' && (
            <>
              <div className="text-green-500 text-4xl mb-3">✓</div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">Saved</h1>
              <p className="text-sm text-gray-500 mb-6">We'll use these the next time there are Verified candidates for you.</p>
              <Link to="/" className="text-sm text-blue-600 hover:underline">Back to Passthrough</Link>
            </>
          )}
          {state === 'gone' && (
            <>
              <div className="text-gray-400 text-4xl mb-3">–</div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">Nothing to update</h1>
              <p className="text-sm text-gray-500 mb-6">We no longer have a request for this address.</p>
              <Link to="/" className="text-sm text-blue-600 hover:underline">Back to Passthrough</Link>
            </>
          )}
          {state === 'error' && (
            <>
              <div className="text-red-500 text-4xl mb-3">✕</div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">Could not open this link</h1>
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
