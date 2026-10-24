import { useEffect, useState } from 'react'
import Footer from './Footer'
import SkipLink from './SkipLink'
import Alert from '../ui/Alert'
import { consumeFlash, peekFlash, flashMessage } from '../../lib/flash'

// The page chrome both shells share: skip link, a header (whatever `header` is), <main id="main"> and the footer.
//
// Round 27 (bug): PageShell chose between <DashboardLayout> and <FocusShell> — two different component types — so when the session
// turned out to be dead (the stored token was refused by /auth/me, which can take seconds on a phone) the whole tree under the
// shell was unmounted and rebuilt. On /scan that threw away a file the person had already picked and a job description they had
// pasted; on a result page it restarted the fetch. Both shells now render THIS frame and differ only in the `header` they hand it,
// so the page in <main> stays mounted when the header changes.
//
// The one-shot notice a redirect leaves behind (a non-admin bounced off /admin) is read on first render and cleared by the effect
// (read-then-clear is split because a render-phase consume is not StrictMode-safe — see peekFlash). `showNotice={false}` still
// consumes it but does not draw it.
export default function ShellFrame({ header, showNotice = true, children }) {
  const [notice] = useState(() => flashMessage(peekFlash()))
  useEffect(() => { consumeFlash() }, [])
  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <SkipLink />
        {header}
      </header>
      <main id="main" className="max-w-5xl mx-auto w-full px-4 py-8 flex-1 min-w-0">
        {showNotice && notice && <Alert variant="warning" className="mb-4">{notice}</Alert>}
        {children}
      </main>
      <Footer />
    </div>
  )
}
