import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { realm, errorMessage } from '../api'
import { Page } from '../Layout'
import Input from '../../components/ui/Input'
import PasswordInput from '../../components/ui/PasswordInput'
import Button from '../../components/ui/Button'
import Alert from '../../components/ui/Alert'

export function Forgot() {
  const [email, setEmail] = useState(''); const [done, setDone] = useState(false); const [busy, setBusy] = useState(false)
  async function submit(e) { e.preventDefault(); setBusy(true); try { await realm.forgot(email.trim()) } catch (_) { /* same answer either way */ } setDone(true); setBusy(false) }
  return (
    <Page title="Reset your password">
      <form className="sheet p-5 space-y-4" onSubmit={submit} noValidate>
        {done ? <Alert variant="success">If that account exists, an email is on its way. The link works once and expires soon.</Alert> : (<>
          <Input label="Email" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required />
          <Button type="submit" loading={busy} className="w-full">Send reset link</Button></>)}
        <p className="text-sm"><Link to="/sign-in">Back to sign in</Link></p>
      </form>
    </Page>
  )
}

// The token is in the URL fragment (#token=...): browsers do not send it to any server and it stays out of request logs.
export function Reset() {
  const { hash } = useLocation(); const nav = useNavigate(); const token = new URLSearchParams(hash.replace(/^#/, '')).get('token') || ''
  const [password, setPassword] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('')
    try { await realm.reset(token, password); nav('/sign-in', { replace: true }) } catch (err) { setError(errorMessage(err, 'This link is not valid or has expired.')) } finally { setBusy(false) }
  }
  return (
    <Page title="Choose a new password">
      <form className="sheet p-5 space-y-4" onSubmit={submit} noValidate>
        {!token && <Alert variant="error">This link is not valid. Ask for a new one.</Alert>}
        {error && <Alert variant="error" focusOnShow>{error}</Alert>}
        <PasswordInput label="New password (12 or more characters)" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} required />
        <Button type="submit" loading={busy} disabled={!token} className="w-full">Set password</Button>
        <p className="text-sm muted">You will sign in again, with your two-factor code. Every other session ends.</p>
      </form>
    </Page>
  )
}
