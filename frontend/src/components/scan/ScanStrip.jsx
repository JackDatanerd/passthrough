import { ATS_BADGE_THRESHOLD } from '../../lib/scoreThresholds'
import { passageSteps, rewrites } from '../../lib/scanTiers'
import { cn } from '../../lib/utils'
import ScoreRing from '../dashboard/ScoreRing'

// Pinned above every step once there is a result: the number that matters now, and where the person is in THEIR passage.
// The passage depends on what they bought: a Verified-only purchase is Scanned, Verified (nothing is rewritten); a plain fix is
// Scanned, Rewritten (no credential exists for it); the full fix is all three. Before a purchase it shows the full passage, which is
// what the offer sells.
const LABEL = { scanned: 'Scanned', rewritten: 'Rewritten', verified: 'Verified' }

export default function ScanStrip({ scan, stage }) {
  if (!scan || !stage) return null
  const tier = stage === 'scored' ? 'FIX' : (scan.fixTier || 'FIX')
  const delivered = stage === 'delivered'
  const rewriting = stage === 'rewriting'
  const fixed = delivered && typeof scan.fixAtsScore === 'number'
  const score = fixed ? scan.fixAtsScore : scan.atsScore
  if (typeof score !== 'number') return null
  const verified = fixed && !!scan.verificationUrl && scan.fixAtsScore >= ATS_BADGE_THRESHOLD
  const rewrote = rewrites(tier)
  const band = fixed ? (verified || tier === 'FIX_PLAIN' ? 'good' : 'mid') : (scan.passed ? 'good' : score >= 50 ? 'mid' : 'low')

  let headline, sub
  if (!fixed) {
    headline = `${score} out of 100`
    sub = rewriting ? (rewrote ? 'Being rewritten now' : 'Being verified now') : 'Scored against this job'
  } else if (rewrote) {
    headline = `${score} out of 100, after the fix`
    sub = `Scored ${scan.atsScore ?? '\u2014'} before`
  } else {
    // Nothing was rewritten: the number is the scan's own, and what changed is whether it now carries the credential.
    headline = `${score} out of 100`
    sub = verified ? 'Credential earned' : `Under the ${ATS_BADGE_THRESHOLD} the credential needs`
  }

  const steps = passageSteps(tier).map(k => ({
    key: k, label: LABEL[k],
    done: k === 'scanned' ? true : k === 'rewritten' ? delivered : verified,
    active: rewriting && (k === 'rewritten' || (k === 'verified' && !rewrote)),
    note: k === 'verified' && delivered && !verified ? `at ${ATS_BADGE_THRESHOLD}` : null,
  }))
  return (
    <div data-testid="scan-strip" data-tier={tier} className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm" aria-live="polite">
      <ScoreRing score={score} band={band} />
      <div className="min-w-[150px] flex-1"><b className="block text-sm font-semibold text-gray-900">{headline}</b><span className="text-xs text-gray-500">{sub}</span></div>
      <ol aria-label="Progress" className="flex list-none gap-1.5 p-0 text-xs font-medium">
        {steps.map(st => (
          <li key={st.key} aria-current={st.active ? 'step' : undefined}
            className={cn('flex items-center gap-1.5 rounded-full border px-2.5 py-0.5', st.done ? 'border-green-700 text-gray-900' : st.active ? 'border-blue-700 text-gray-900' : 'border-gray-200 text-gray-500')}>
            <i aria-hidden="true" className={cn('h-2 w-2 rounded-full', st.done ? 'bg-green-700' : st.active ? 'bg-blue-700 motion-safe:animate-pulse' : 'bg-gray-300')} />
            {st.label}{st.note && <span className="font-normal text-gray-500"> {'\u00b7'} {st.note}</span>}
          </li>
        ))}
      </ol>
    </div>
  )
}
