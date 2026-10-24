import { ATS_BADGE_THRESHOLD } from '../../lib/scoreThresholds'
import { cn } from '../../lib/utils'

// Pinned above every step once there is a result: the number that matters now, and where the person is in the three-step
// passage (Scanned, Rewritten, Verified), so no step has to repeat it and none can lose it.
function Mini({ value, tone }) {
  const r = 19, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, Number(value) || 0))
  return (
    <div className="relative h-[46px] w-[46px] flex-none">
      <svg width="46" height="46" viewBox="0 0 46 46" aria-hidden="true" className="-rotate-90">
        <circle cx="23" cy="23" r={r} fill="none" stroke="#E5E7EB" strokeWidth="5" />
        <circle cx="23" cy="23" r={r} fill="none" stroke={tone} strokeWidth="5" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - v / 100)} />
      </svg>
      <b aria-hidden="true" className="absolute inset-0 grid place-items-center font-display text-[15px] font-extrabold text-ink">{value}</b>
    </div>
  )
}

export default function ScanStrip({ scan, stage }) {
  if (!scan || !stage) return null
  const delivered = stage === 'delivered'
  const fixed = delivered && typeof scan.fixAtsScore === 'number'
  const score = fixed ? scan.fixAtsScore : scan.atsScore
  if (typeof score !== 'number') return null
  const verified = fixed && !!scan.verificationUrl && scan.fixAtsScore >= ATS_BADGE_THRESHOLD
  const tone = fixed ? (verified ? '#16A34A' : '#F59E0B') : (scan.passed ? '#16A34A' : score >= 50 ? '#F59E0B' : '#DC2626')
  const headline = fixed ? `${score} out of 100, after the fix` : `${score} out of 100`
  const sub = fixed ? `Scored ${scan.atsScore ?? '\u2014'} before` : stage === 'rewriting' ? 'Being rewritten now' : 'Scored against this job'
  const steps = [
    { label: 'Scanned', done: true },
    { label: 'Rewritten', done: delivered, active: stage === 'rewriting' },
    { label: 'Verified', done: verified, note: delivered && !verified ? `at ${ATS_BADGE_THRESHOLD}` : null },
  ]
  return (
    <div data-testid="scan-strip" className="flex flex-wrap items-center gap-3.5 rounded-[14px] border border-gray-200 bg-white px-3.5 py-2.5" aria-live="polite">
      <Mini value={score} tone={tone} />
      <div className="min-w-[150px] flex-1"><b className="block text-[14.5px] text-ink">{headline}</b><span className="text-[12.5px] text-gray-500">{sub}</span></div>
      <ol aria-label="Progress" className="flex list-none gap-1.5 p-0 text-xs font-bold">
        {steps.map(st => (
          <li key={st.label} aria-current={st.active ? 'step' : undefined}
            className={cn('flex items-center gap-1.5 rounded-full border px-[9px] py-[3px]', st.done ? 'border-green-700 text-ink' : st.active ? 'border-blue-700 text-ink' : 'border-gray-200 text-gray-500')}>
            <i aria-hidden="true" className={cn('h-2 w-2 rounded-full', st.done ? 'bg-green-700' : st.active ? 'bg-blue-700 motion-safe:animate-pulse' : 'bg-gray-300')} />
            {st.label}{st.note && <span className="font-normal text-gray-500"> {'\u00b7'} {st.note}</span>}
          </li>
        ))}
      </ol>
    </div>
  )
}
