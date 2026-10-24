import { Link, useLocation } from 'react-router-dom'
import ShellFrame from './ShellFrame'
import LogoMark from './LogoMark'

// The header for someone who is not signed in and is doing the one thing they came for: scan, or read a result. The marketing
// navbar (How it works, Stories, Pricing, For employers…) and the 12-section sales page are what they just left; here there is
// the logo, a way back, and Sign in. A signed-in person gets the app's own header instead (PageShell). Exported on its own
// (round 27) so PageShell can swap headers without remounting the page.
export function VisitorHeader() {
  const { pathname, search } = useLocation()
  // Back to this very page after signing in (Login validates ?next= via safeNext).
  const next = encodeURIComponent(pathname + search)
  return (
    <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between gap-4">
      <Link to="/" className="flex items-center gap-2 font-display font-extrabold text-ink text-xl tracking-[-0.03em]">
        <LogoMark className="w-7 h-7" />
        Passthrough
      </Link>
      <nav aria-label="Account" className="flex items-center gap-4 text-sm font-semibold">
        <Link to="/pricing" className="hidden sm:inline text-gray-600 hover:text-gray-900 transition-colors">Pricing</Link>
        <Link to={`/login?next=${next}`} className="text-gray-600 hover:text-gray-900 transition-colors">Sign in</Link>
      </nav>
    </div>
  )
}

export default function FocusShell({ children }) {
  return <ShellFrame header={<VisitorHeader />} showNotice={false}>{children}</ShellFrame>
}
