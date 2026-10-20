import { useEffect, useRef, useState } from 'react'
import api, { setSessionResumePrompt, getErrorMessage } from '../../lib/api'
import { useAuth } from '../../hooks/useAuth'
import Modal from '../ui/Modal'
import Form from '../ui/Form'
import PasswordInput from '../ui/PasswordInput'
import Button from '../ui/Button'
import Alert from '../ui/Alert'

// FEATURE GAP CLOSED (Shared frontend round 9): when a session ended (a sign-out elsewhere, the absolute expiry) while an
// editor held unsaved changes, lib/api.js hard-redirected to /login — the draft was gone, and answering "Stay" to the
// browser's prompt left a page whose every save failed. lib/api.js now asks this component instead (only while
// lib/unsavedGuard reports unsaved work): the person signs in again right here, as the SAME account, and the request
// that was refused is replayed — nothing they typed is lost. "Discard" falls back to the normal redirect.
// A banned account is never offered this.
export default function SessionResumePrompt() {
  const { user, adoptSession } = useAuth()
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const entry = useRef(null)
  const userRef = useRef(user)
  userRef.current = user
  const adoptRef = useRef(adoptSession)
  adoptRef.current = adoptSession

  function finish(ok) {
    const e = entry.current
    entry.current = null
    setOpen(false); setPassword(''); setError('')
    e?.resolve(ok)
  }

  useEffect(() => {
    setSessionResumePrompt(() => {
      if (!userRef.current?.email) return Promise.resolve(false)   // nobody to sign back in as
      if (entry.current) return entry.current.promise
      let resolve
      const promise = new Promise(r => { resolve = r })
      entry.current = { resolve, promise }
      setPassword(''); setError(''); setOpen(true)
      return promise
    })
    return () => {
      setSessionResumePrompt(null)
      entry.current?.resolve(false)
      entry.current = null
    }
  }, [])

  async function submit() {
    if (busy) return
    if (!password) { setError('Enter your password.'); return }
    setBusy(true); setError('')
    try {
      const res = await api.post('/auth/login', { email: userRef.current.email, password })
      const { token, user: fresh } = res.data.data
      if (!fresh || fresh.id !== userRef.current?.id) {
        setError('That sign-in belongs to a different account, so your changes were not resumed.')
        return
      }
      adoptRef.current(token, fresh)
      finish(true)
    } catch (err) {
      setError(getErrorMessage(err, 'Sign-in failed. Please try again.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={() => {}} title="Your session ended" dismissible={false}>
      <Form onSubmit={submit} className="flex flex-col gap-3">
        <p className="text-sm text-gray-600">
          You were signed out, but what you typed on this page is still here. Sign in again to carry on and save it.
        </p>
        <p className="text-sm text-gray-700">Signed in as <span className="font-medium">{user?.email}</span></p>
        {/* Round 21: a password manager fills a password only next to the username it belongs to; the email is shown above as text, so
            it also rides along here (read-only, out of the Tab order, hidden from assistive tech — the line above already says it). */}
        <input type="email" name="username" autoComplete="username" value={user?.email || ''} readOnly tabIndex={-1} aria-hidden="true" className="sr-only" />
        <PasswordInput label="Password" value={password} onChange={e => setPassword(e.target.value)}
          autoComplete="current-password" data-autofocus />
        <Alert>{error}</Alert>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" size="sm" onClick={() => finish(false)} disabled={busy}>
            Discard my changes
          </Button>
          <Button type="submit" size="sm" loading={busy}>Sign in and continue</Button>
        </div>
      </Form>
    </Modal>
  )
}
