import { useAuth } from '../../hooks/useAuth'
import { getToken } from '../../lib/storage'
import DashboardLayout from './DashboardLayout'
import FocusShell from './FocusShell'

// One page, two shells, chosen by the session and nothing else: the signed-in person stays inside the app they know
// (its tabs, its Sign out), a visitor gets the stripped header. Used by /scan and by a scan's result, so neither ever
// shows the marketing site's navigation again.
//
// While the session is still being confirmed (a token is stored and /auth/me has not answered) the app shell is shown:
// the page is far more often opened by a returning person than by a stranger carrying a stale token, and the other
// order would flash a "Sign in" link at someone who is signed in. A token that turns out dead swaps to the visitor shell.
export default function PageShell({ children }) {
  const { user, authLoading } = useAuth()
  const signedIn = !!user || (!!authLoading && !!getToken())
  return signedIn ? <DashboardLayout>{children}</DashboardLayout> : <FocusShell>{children}</FocusShell>
}
