// Shown once, straight after sign-in, when codes were just issued. The codes live only in this navigation state: reload and they are gone (by design).
import { Link, useLocation } from 'react-router-dom'
import { Page } from '../Layout'
import Alert from '../../components/ui/Alert'
import { useSession, mayShow } from '../session'

export default function RecoveryCodes() {
  const { state } = useLocation(); const { me } = useSession(); const codes = state && state.codes; const left = state && state.left
  const next = me && mayShow(me.roles, 'board') ? '/admin' : '/desk'
  return (
    <Page title={codes ? 'Save your recovery codes' : 'Signed in'}>
      <div className="sheet p-5 space-y-3">
        {codes ? (<>
          <Alert variant="warning">These ten codes are shown once. Each works one time if you lose your phone. Store them somewhere safe, away from this device.</Alert>
          <ul className="grid grid-cols-2 gap-2 serif" data-testid="recovery-codes">{codes.map(c => <li key={c}>{c}</li>)}</ul></>)
          : <p>{left !== null && left !== undefined ? `You signed in with a recovery code. ${left} left. Make a new set in Settings when you can.` : 'You are signed in.'}</p>}
        <p><Link to={next}>Continue</Link></p>
      </div>
    </Page>
  )
}
