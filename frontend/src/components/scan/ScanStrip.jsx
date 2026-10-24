import { ATS_BADGE_THRESHOLD } from '../../lib/scoreThresholds'
import { cn } from '../../lib/utils'

// Pinned above every step once there is a result: the number that matters now, and where the person is in the three-step
// passage (Scanned, Rewritten, Verified), so no tab has to repeat it and none can lose it.
function Ring({ value, tone }) {
  const r = 19, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, Number(value) || 0))
  return (
    <svg width="46" height="46" viewBox="0 0 46 46" aria-hidden="true" className="shrink-0 -rotate-90">
      <circle cx="23" cy="23" r={r} fill="none" stroke="#E5E7EB" strokeWidth="5" />
      <circle cx="23" cy="23" r={r} fill="none" stroke={tone} strokeWidth="5" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - v / 100)} />
    </svg>
  )
}

export default function ScanStrip({ scan, stage }) {
  if (!scan || !stage) return null
  const delivered = stage === 'delivered'
  const fixed = delivered && typeof scan.fixAtsScore === 'number'
  const score = fixed ? scan.fixAtsScore : scan.atsScore
  if (typeof score !== 'number') return null
  const verified = fixed && !!scan.verificationUrl && scan.fixAtsScore >= ATS_BADGE_THRESHOLD
  const tone = fixed ? (verified ? '#16A34A' : '#D97706') : (scan.passed ? '#16A34A' : '#DC2626')
  const headline = fixed ? `${score} out of 100, after the fix` : `${score} out of 100`
  const sub = fixed ? `Scored ${scan.atsScore ?? '—'} before` : stage === 'rewriting' ? 'Being rewritten now' : 'Scored against this job'
  const steps = [
    { label: 'Scanned', done: true },
    { label: 'Rewritten', done: delivered, active: stage === 'rewriting' },
    { label: 'Verified', done: verified, note: delivered && !verified ? `at ${ATS_BADGE_THRESHOLD}` : null },
  ]
  return (
    <div data-testid="scan-strip" className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm" aria-live="polite">
      <div className="flex items-center gap-3 min-w-0">
        <Ring value={score} tone={tone} />
        <div className="min-w-0"><b className="block text-sm text-gray-900">{headline}</b><span className="text-xs text-gray-500">{sub}</span></div>
      </div>
      <ol aria-label="Progress" className="ml-auto flex items-center gap-4 text-xs font-semibold">
        {steps.map(st => (
          <li key={st.label} aria-current={st.active ? 'step' : undefined} className={cn('flex items-center gap-1.5', st.done ? 'text-green-700' : st.active ? 'text-blue-700' : 'text-gray-400')}>
            <i aria-hidden="true" className={cn('w-4 h-4 rounded-full border-2 grid place-items-center not-italic text-[10px] leading-none', st.done ? 'bg-green-600 border-green-600 text-white' : st.active ? 'border-blue-600' : 'border-gray-300')}>{st.done ? '✓' : ''}</i>
            {st.label}{st.note && <span className="font-normal text-gray-500"> · {st.note}</span>}
          </li>
        ))}
      </ol>
    </div>
  )
}
