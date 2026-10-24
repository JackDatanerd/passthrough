import { Link } from 'react-router-dom'
import Checkbox from '../ui/Checkbox'
import ButtonLink from '../ui/ButtonLink'
import Menu from '../ui/Menu'
import CopyButton from '../ui/CopyButton'
import ScoreRing, { barColor } from './ScoreRing'
import { formatDate } from '../../lib/utils'
import { ATS_PASS_THRESHOLD, ATS_BADGE_THRESHOLD } from '../../lib/scoreThresholds'
import { canDeleteScan, scanHeading, scanDetails } from '../../lib/scanDisplay'
import { displayScore, scanNeed, scanMessage, stages } from '../../lib/scanNext'

const TONE = { g: 'bg-green-100 text-green-800', a: 'bg-amber-100 text-amber-800', r: 'bg-red-100 text-red-700', b: 'bg-blue-100 text-blue-800' }
const STAGE_NAMES = ['Scanned', 'Fixed', 'Verified']
const STAGE_CLASS = { done: 'text-green-700 font-semibold', now: 'text-blue-700 font-semibold', todo: 'text-gray-400' }
const RESCANNABLE = ['COMPLETE_PASS', 'COMPLETE_FAIL', 'FIX_PURCHASED', 'FIX_GENERATING', 'FIX_DELIVERED']

export function StageTracker({ scan, now }) {
  const st = stages(scan, now)
  return (
    <ol aria-label="Progress" className="flex items-center gap-1.5 text-xs">
      {STAGE_NAMES.map((name, i) => (
        <li key={name} className={`flex items-center gap-1.5 ${STAGE_CLASS[st[i]]}`} aria-current={st[i] === 'now' ? 'step' : undefined}>
          {i > 0 && <span aria-hidden="true" className="h-px w-3 bg-gray-300" />}
          {st[i] === 'done' ? '✓ ' : ''}{name}{st[i] === 'done' && <span className="sr-only"> done</span>}
        </li>
      ))}
    </ol>
  )
}

// The score on a bar with the pass line and the credential line marked; a delivered fix shows the gain.
export function Gauge({ scan }) {
  const n = displayScore(scan)
  if (n == null || scan.status === 'ERROR') return null
  const fixed = scan.fixPurchased && scan.fixAtsScore != null && scan.atsScore != null
  return (
    <div role="img" className="relative mt-1.5 h-1.5 max-w-xs rounded-full bg-gray-100"
      aria-label={`Score ${n}${fixed ? `, up from ${scan.atsScore}` : ''}. Pass line ${ATS_PASS_THRESHOLD}, credential line ${ATS_BADGE_THRESHOLD}.`}>
      <i className={`absolute inset-y-0 left-0 rounded-full ${fixed ? 'opacity-40' : ''} ${barColor(n)}`} style={{ width: `${n}%` }} />
      {fixed && <i className={`absolute inset-y-0 left-0 rounded-full ${barColor(scan.atsScore)}`} style={{ width: `${scan.atsScore}%` }} />}
      {[ATS_PASS_THRESHOLD, ATS_BADGE_THRESHOLD].map(t => <u key={t} aria-hidden="true" className="absolute -top-0.5 -bottom-0.5 w-px bg-gray-500 no-underline" style={{ left: `${t}%` }} />)}
    </div>
  )
}

const itemClass = 'block w-full text-left px-3 py-2 text-sm rounded-md text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed'

// `prices`: { fix, badge } already formatted ('$29'); `credits`: free fix credits the person holds.
export default function ScanRow({ scan, now, credits = 0, prices = {}, selected, onToggle, onDelete, onBreakdown }) {
  const need = scanNeed(scan, now)
  const msg = scanMessage(scan, now)
  const heading = scanHeading(scan)
  const to = `/scan/${scan.id}`
  const fixLabel = credits > 0 ? 'Fix · free credit' : prices.fix ? `Fix · ${prices.fix}` : 'Fix this resume'
  const link = scan.verificationUrl || (typeof window !== 'undefined' ? `${window.location.origin}/v/${scan.verificationCode}` : '')

  return (
    <li data-testid="scan-row" className="bg-white rounded-lg border border-gray-200 hover:border-blue-300 transition-colors p-4 flex gap-3 items-start">
      <span className="pt-4"><Checkbox className="disabled:opacity-40" checked={selected} disabled={!canDeleteScan(scan, now)} onChange={() => onToggle(scan.id)} aria-label={`Select ${heading}`} /></span>
      <ScoreRing score={displayScore(scan)} />
      <div className="min-w-0 flex-1">
        <Link to={to} className="font-medium text-gray-900 hover:text-blue-700 truncate block">{heading}</Link>
        <p className="text-xs text-gray-400 mt-0.5 truncate">{[...scanDetails(scan), formatDate(scan.createdAt)].join(' · ')}</p>
        <div className="mt-2"><StageTracker scan={scan} now={now} /></div>
        <Gauge scan={scan} />
        <p className="mt-2 text-sm text-gray-700">
          <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-semibold mr-1.5 ${TONE[msg.tone]}`}>{msg.label}</span>{msg.text}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 shrink-0 max-w-[16rem]">
        {need === 'fix' && <ButtonLink to={to} size="sm">{fixLabel}</ButtonLink>}
        {need === 'cred' && <ButtonLink to={to} size="sm">{prices.badge ? `Credential · ${prices.badge}` : 'Get the credential'}</ButtonLink>}
        {need === 'retryfix' && <ButtonLink to={to} size="sm">Use a free retry</ButtonLink>}
        {need === 'error' && <ButtonLink to={to} size="sm" variant="secondary">See what happened</ButtonLink>}
        {need === 'share' && <CopyButton text={link} label="Copy link" />}
        {['share', 'retryfix', 'download'].includes(need) && <ButtonLink to={to} size="sm" variant="secondary" title="Your files are on the scan page">Download</ButtonLink>}
        <Menu label={`More actions for ${heading}`}>
          <button type="button" role="menuitem" className={itemClass} onClick={() => onBreakdown(scan)}>See the breakdown</button>
          {RESCANNABLE.includes(scan.status) && <Link role="menuitem" className={itemClass} to={`/scan?from=${scan.id}`}>Scan this resume against another job</Link>}
          <button type="button" role="menuitem" className={`${itemClass} text-red-600`} disabled={!canDeleteScan(scan, now)}
            title={canDeleteScan(scan, now) ? 'Delete this scan' : 'Available once processing finishes'}
            aria-label={`Delete ${heading}`} onClick={() => onDelete(scan)}>Delete…</button>
        </Menu>
      </div>
    </li>
  )
}
