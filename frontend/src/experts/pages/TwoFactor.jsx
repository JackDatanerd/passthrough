// Second factor: first sign-in shows the setup secret (and the QR link) once; later sign-ins ask for the 6-digit code; a lost phone uses a recovery code.
import { useEffect, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { realm, errorMessage } from '../api'
import { useSession } from '../session'
import { Page } from '../Layout'
import Input from '../../components/ui/Input'
import Button from '../../components/ui/Button'
import Alert from '../../components/ui/Alert'

export default function TwoFactor() {
  const nav = useNavigate(); const { stage, refresh, setStage } = useSession()
  const [setup, setSetup] = useState(null); const [code, setCode] = useState(''); const [useRecovery, setUseRecovery] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  useEffect(() => { if (stage === 'enroll' && !setup) realm.totpSetup().then(setSetup).catch(err => setError(errorMessage(err))) }, [stage, setup])
  if (!stage) return <Navigate to="/sign-in" replace />
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('')
    try {
      const r = useRecovery ? await realm.recover(code) : await realm.totp(code)
      await refresh(); setStage(null)
      nav('/recovery-codes', { replace: true, state: { codes: r.recoveryCodes || null, left: r.recoveryCodesLeft ?? null } })
    } catch (err) { setError(errorMessage(err, 'That code did not work.')); setCode('') } finally { setBusy(false) }
  }
  return (
    <Page title={stage === 'enroll' ? 'Set up two-factor' : 'Two-factor code'}>
      <form className="sheet p-5 space-y-4" onSubmit={submit} noValidate>
        {error && <Alert variant="error" focusOnShow>{error}</Alert>}
        {stage === 'enroll' && (
          <div className="space-y-2 text-sm">
            <p>Add this account to an authenticator app on your phone, then enter the 6-digit code it shows.</p>
            {setup ? (<>
              <p className="muted">Setup key (shown once): <code data-testid="setup-secret" className="serif">{setup.secret}</code></p>
              <p><a href={setup.otpauthUrl}>Open in your authenticator app</a></p></>) : <p className="muted">Preparing your setup key...</p>}
          </div>
        )}
        <Input label={useRecovery ? 'Recovery code' : '6-digit code'} inputMode={useRecovery ? 'text' : 'numeric'} autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} required />
        <Button type="submit" loading={busy} className="w-full">Verify</Button>
        {stage === 'mfa' && <p className="text-sm"><button type="button" className="underline" onClick={() => { setUseRecovery(v => !v); setCode(''); setError('') }}>{useRecovery ? 'Use my authenticator app' : 'I lost my phone: use a recovery code'}</button></p>}
      </form>
    </Page>
  )
}
