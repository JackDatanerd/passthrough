import { Link } from 'react-router-dom'
import api from '../../lib/api'
import Button from '../ui/Button'
import ButtonLink from '../ui/ButtonLink'
import { useCopy } from '../../hooks/useCopy'
import { buildBadgeEmbeds } from '../../lib/badgeEmbed'
import { scanHeading } from '../../lib/scanDisplay'
import { displayScore } from '../../lib/scanNext'

// Same absolute API root ScanResult.jsx uses for the badge image, so a pasted snippet works anywhere.
function badgeHtml(scan, pageUrl) {
  let root = String(api.defaults.baseURL || '')
  try { root = new URL(root, window.location.origin).href.replace(/\/+$/, '') } catch (_) { /* keep as is */ }
  return buildBadgeEmbeds(root, scan.verificationCode, pageUrl).html
}

export default function CredentialCard({ scan }) {
  const link = useCopy()
  const badge = useCopy()
  const pageUrl = scan.verificationUrl || `${window.location.origin}/v/${scan.verificationCode}`
  return (
    <article className="rounded-lg border border-gray-200 bg-white p-4 flex flex-col gap-3">
      <div>
        <Link to={`/scan/${scan.id}`} className="font-semibold text-gray-900 hover:text-blue-700">{scanHeading(scan)}</Link>
        <p className="text-sm text-gray-500">{displayScore(scan)} / 100 · Active</p>
      </div>
      <code className="block rounded bg-gray-50 border border-gray-200 px-3 py-2 text-xs text-gray-700 break-all">{pageUrl}</code>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => link.copy(pageUrl)}>{link.copied ? 'Copied' : link.failed ? 'Copy failed' : 'Copy link'}</Button>
        <Button size="sm" variant="secondary" onClick={() => badge.copy(badgeHtml(scan, pageUrl))}>{badge.copied ? 'Copied' : badge.failed ? 'Copy failed' : 'Copy badge HTML'}</Button>
        <ButtonLink to={`/v/${scan.verificationCode}`} size="sm" variant="secondary">View as an employer</ButtonLink>
      </div>
    </article>
  )
}
