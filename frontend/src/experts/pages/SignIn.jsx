import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { realm, errorMessage } from '../api'
import { useSession } from '../session'
import { Page } from '../Layout'
import Input from '../../components/ui/Input'
import PasswordInput from '../../components/ui/PasswordInput'
import Button from '../../components/ui/Button'
import Alert from '../../components/ui/Alert'

export default function SignIn() {
  const nav = useNavigate(); const { setStage, ended } = useSession()
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('')
    try { const r = await realm.login(email.trim(), password); setPassword(''); setStage(r.stage); nav('/two-factor') }
    catch (err) { setError(errorMessage(err, 'Email or password is not correct.')) } finally { setBusy(false) }
  }
  return (
    <Page title="Sign in">
      <form className="sheet p-5 space-y-4" onSubmit={submit} noValidate>
        {ended && !error && <Alert variant="info" focusOnShow>Your session ended. Please sign in again.</Alert>}
        {error && <Alert variant="error" focusOnShow>{error}</Alert>}
        <Input label="Email" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required />
        <PasswordInput label="Password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required />
        <Button type="submit" loading={busy} className="w-full">Continue</Button>
        <p className="text-sm muted"><Link to="/forgot-password">Forgot your password?</Link></p>
      </form>
    </Page>
  )
}
