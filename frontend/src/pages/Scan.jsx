import PageShell from '../components/layout/PageShell'
import ScanComposer from '../components/scan/ScanComposer'

// /scan: the front door. A signed-in person sees it inside the app (the dashboard's header and tabs); a visitor sees it
// inside the stripped header. The page is private to search engines (lib/pageTitles.js PRIVATE) and carries no marketing.
export default function Scan() {
  return (
    <PageShell>
      <ScanComposer />
    </PageShell>
  )
}
