import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { realm, errorMessage, errorCode } from '../api'
import { useSession } from '../session'
import { Page } from '../Layout'
import Button from '../../components/ui/Button'
import Alert from '../../components/ui/Alert'
import PasswordInput from '../../components/ui/PasswordInput'

export default function Settings() {
  const nav = useNavigate(); const { me, refresh } = useSession()
  const [sessions, setSessions] = useState(null); const [error, setError] = useState(''); const [info, setInfo] = useState('')
  const [cur, setCur] = useState(''); const [next, setNext] = useState(''); const [codes, setCodes] = useState(null); const [stepPw, setStepPw] = useState(''); const [needStep, setNeedStep] = useState(false)
  const load = () => realm.sessions().then(setSessions).catch(err => setError(errorMessage(err)))
  useEffect(() => { load() }, [])
  const run = async fn => { setError(''); setInfo(''); try { await fn() } catch (err) { setError(errorMessage(err)) } }
  return (
    <Page title="Account settings" wide>
      {error && <Alert variant="error" className="mb-3">{error}</Alert>}{info && <Alert variant="success" className="mb-3">{info}</Alert>}
      <section className="sheet p-5 mb-4"><h2 className="serif text-lg mb-2">Sessions</h2>
        <p className="text-sm muted mb-2">Each sign-in ends after 8 hours without use, or 7 days at most.</p>
        {sessions && <ul className="space-y-2">{sessions.map(s => (
          <li key={s.id} className="flex items-center justify-between gap-2 text-sm"><span>{s.device || 'Unknown device'}{s.current && <span className="pill ml-2 ok">This device</span>}<br /><span className="muted">Last active {new Date(s.lastSeenAt).toUTCString()}</span></span>
            {!s.current && <Button size="sm" variant="secondary" onClick={() => run(async () => { await realm.endSession(s.id); await load() })}>End</Button>}</li>))}</ul>}
        <div className="mt-3"><Button variant="danger" onClick={() => run(async () => { await realm.logoutAll(); await refresh(); nav('/sign-in') })}>Sign out everywhere</Button></div>
      </section>
      <section className="sheet p-5 mb-4"><h2 className="serif text-lg mb-2">Password</h2>
        <form className="space-y-3" onSubmit={e => { e.preventDefault(); run(async () => { await realm.changePassword(cur, next); await refresh(); nav('/sign-in') }) }}>
          <PasswordInput label="Current password" autoComplete="current-password" value={cur} onChange={e => setCur(e.target.value)} />
          <PasswordInput label="New password (12 or more characters)" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} />
          <Button type="submit">Change password</Button><p className="text-xs muted">Changing it signs you out everywhere.</p></form>
      </section>
      <section className="sheet p-5"><h2 className="serif text-lg mb-2">Recovery codes</h2>
        <p className="text-sm muted mb-2">A new set replaces the old one. Ten single-use codes, shown once.</p>
        {needStep && <form className="space-y-2 mb-2" onSubmit={e => { e.preventDefault(); run(async () => { await realm.stepUp(stepPw); setStepPw(''); setNeedStep(false); setCodes((await realm.newRecoveryCodes()).recoveryCodes) }) }}>
          <PasswordInput label="Confirm your password" autoComplete="current-password" value={stepPw} onChange={e => setStepPw(e.target.value)} /><Button type="submit">Confirm</Button></form>}
        {!needStep && <Button variant="secondary" onClick={() => run(async () => { try { setCodes((await realm.newRecoveryCodes()).recoveryCodes) } catch (err) { if (errorCode(err) === 'STEP_UP_REQUIRED') setNeedStep(true); else throw err } })}>Make new recovery codes</Button>}
        {codes && <ul className="grid grid-cols-2 gap-2 serif mt-3" data-testid="new-recovery-codes">{codes.map(c => <li key={c}>{c}</li>)}</ul>}
      </section>
      <p className="text-xs muted mt-3">Signed in as {me && me.firstName}. Roles: {me && me.roles.join(', ')}.</p>
    </Page>
  )
}
