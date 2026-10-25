import { ATS_BADGE_THRESHOLD } from '../../lib/scoreThresholds'
import { cn } from '../../lib/utils'
import ScoreRing from '../dashboard/ScoreRing'

// Pinned above every step once there is a result: the number that matters now, and where the person is in the three-step
// passage (Scanned, Rewritten, Verified), so no step has to repeat it and none can lose it.
export default function ScanStrip({ scan, stage }) {
  if (!scan || !stage) return null
  const delivered = stage === 'delivered'
  const fixed = delivered && typeof scan.fixAtsScore === 'number'
  const score = fixed ? scan.fixAtsScore : scan.atsScore
  if (typeof score !== 'number') return null
  const verified = fixed && !!scan.verificationUrl && scan.fixAtsScore >= ATS_BADGE_THRESHOLD
  const band = fixed ? (verified ? 'good' : 'mid') : (scan.passed ? 'good' : score >= 50 ? 'mid' : 'low')
  const headline = fixed ? `${score} out of 100, after the fix` : `${score} out of 100`
  const sub = fixed ? `Scored ${scan.atsScore ?? '\u2014'} before` : stage === 'rewriting' ? 'Being rewritten now' : 'Scored against this job'
  const steps = [
    { label: 'Scanned', done: true },
    { label: 'Rewritten', done: delivered, active: stage === 'rewriting' },
    { label: 'Verified', done: verified, note: delivered && !verified ? `at ${ATS_BADGE_THRESHOLD}` : null },
  ]
  return (
    <div data-testid="scan-strip" className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm" aria-live="polite">
      <ScoreRing score={score} band={band} />
      <div className="min-w-[150px] flex-1"><b className="block text-sm font-semibold text-gray-900">{headline}</b><span className="text-xs text-gray-500">{sub}</span></div>
      <ol aria-label="Progress" className="flex list-none gap-1.5 p-0 text-xs font-medium">
        {steps.map(st => (
          <li key={st.label} aria-current={st.active ? 'step' : undefined}
            className={cn('flex items-center gap-1.5 rounded-full border px-2.5 py-0.5', st.done ? 'border-green-700 text-gray-900' : st.active ? 'border-blue-700 text-gray-900' : 'border-gray-200 text-gray-500')}>
            <i aria-hidden="true" className={cn('h-2 w-2 rounded-full', st.done ? 'bg-green-700' : st.active ? 'bg-blue-700 motion-safe:animate-pulse' : 'bg-gray-300')} />
            {st.label}{st.note && <span className="font-normal text-gray-500"> {'\u00b7'} {st.note}</span>}
          </li>
        ))}
      </ol>
    </div>
  )
}
