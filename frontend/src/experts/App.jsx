// Experts Phase 2A: the expert site's routes. Every screen except sign-in and reset needs a fully signed-in session; role-only screens also
// hide themselves from roles the server would refuse (the server is what actually decides).
import { Navigate, Route, Routes } from 'react-router-dom'
import { Shell } from './Layout'
import { useSession, mayShow } from './session'
import Spinner from '../components/ui/Spinner'
import SignIn from './pages/SignIn'
import TwoFactor from './pages/TwoFactor'
import RecoveryCodes from './pages/RecoveryCodes'
import { Forgot, Reset } from './pages/PasswordReset'
import Desk from './pages/Desk'
import Settings from './pages/Settings'
import { Board, JobDetail, Directory, AuditLog } from './pages/Admin'

function Gate({ area, children }) {
  const { status, me } = useSession()
  if (status === 'loading') return <div className="p-8 flex justify-center"><Spinner /></div>
  if (status !== 'in') return <Navigate to="/sign-in" replace />
  if (area && !mayShow(me.roles, area)) return <Navigate to="/" replace />
  return children
}
function Home() {
  const { status, me } = useSession()
  if (status === 'loading') return <div className="p-8 flex justify-center"><Spinner /></div>
  if (status !== 'in') return <Navigate to="/sign-in" replace />
  return <Navigate to={mayShow(me.roles, 'board') ? '/admin' : '/desk'} replace />
}

export default function App() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/sign-in" element={<SignIn />} />
        <Route path="/two-factor" element={<TwoFactor />} />
        <Route path="/recovery-codes" element={<Gate><RecoveryCodes /></Gate>} />
        <Route path="/forgot-password" element={<Forgot />} />
        <Route path="/reset-password" element={<Reset />} />
        <Route path="/desk" element={<Gate area="desk"><Desk /></Gate>} />
        <Route path="/settings" element={<Gate><Settings /></Gate>} />
        <Route path="/admin" element={<Gate area="board"><Board /></Gate>} />
        <Route path="/admin/jobs/:id" element={<Gate area="board"><JobDetail /></Gate>} />
        <Route path="/admin/experts" element={<Gate area="directory"><Directory /></Gate>} />
        <Route path="/admin/audit" element={<Gate area="audit"><AuditLog /></Gate>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  )
}
