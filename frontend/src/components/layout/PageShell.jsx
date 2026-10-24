import { useAuth } from '../../hooks/useAuth'
import { getToken } from '../../lib/storage'
import ShellFrame from './ShellFrame'
import { AppHeader } from './DashboardLayout'
import { VisitorHeader } from './FocusShell'

// One page, two headers, chosen by the session and nothing else: the signed-in person stays inside the app they know (its tabs,
// its Sign out), a visitor gets the stripped header. Used by /scan and by a scan's result, so neither ever shows the marketing
// site's navigation again.
//
// While the session is still being confirmed (a token is stored and /auth/me has not answered) the app header is shown: the page is
// far more often opened by a returning person than by a stranger carrying a stale token, and the other order would flash a
// "Sign in" link at someone who is signed in. A token that turns out dead swaps to the visitor header.
//
// Round 27: the swap changes ONLY the header. This used to return <DashboardLayout> or <FocusShell> (different component types), and
// React rebuilt everything under them on the swap — a file already picked on /scan, a pasted job description, a result page's fetch.
// Both now render the same <ShellFrame>, so the page in <main> keeps its state.
export default function PageShell({ children }) {
  const { user, authLoading } = useAuth()
  const signedIn = !!user || (!!authLoading && !!getToken())
  return (
    <ShellFrame header={signedIn ? <AppHeader /> : <VisitorHeader />} showNotice={signedIn}>
      {children}
    </ShellFrame>
  )
}
