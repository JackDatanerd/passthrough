import { ATS_PASS_THRESHOLD, ATS_BADGE_THRESHOLD } from '../../lib/scoreThresholds'

// A score on a road with the two lines that matter drawn on it: the pass line and the Verified line. `before` is
// shown as a ghost marker so a fix reads as movement, not just a new number. Pure presentation of numbers the
// server already computed; it decides nothing.
const clamp = n => Math.max(0, Math.min(100, n))
const valid = n => typeof n === 'number' && Number.isFinite(n)

export default function ScoreRoad({ before, after }) {
  if (!valid(after)) return null
  const hasBefore = valid(before)
  const tone = after >= ATS_BADGE_THRESHOLD ? 'bg-green-600' : after >= ATS_PASS_THRESHOLD ? 'bg-blue-600' : 'bg-amber-500'
  const label = `Score ${after} out of 100${hasBefore ? `, was ${before}` : ''}. Pass line ${ATS_PASS_THRESHOLD}, Verified line ${ATS_BADGE_THRESHOLD}.`
  return (
    <div role="img" aria-label={label} data-testid="score-road" className="relative h-2.5 rounded-full bg-gray-200 mt-9 mb-9">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${clamp(after)}%` }} />
      {hasBefore && before !== after && (
        <div data-testid="score-road-before" className="absolute top-1/2 h-4 w-0.5 -translate-y-1/2 bg-gray-500"
             style={{ left: `${clamp(before)}%` }} title={`Was ${before}`} />
      )}
      <div className="absolute -top-1.5 -bottom-1.5 w-0.5 bg-gray-900" style={{ left: `${ATS_PASS_THRESHOLD}%` }}>
        <span className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 text-[11px] font-medium text-gray-500 whitespace-nowrap">Pass {ATS_PASS_THRESHOLD}</span>
      </div>
      <div className="absolute -top-1.5 -bottom-1.5 w-0.5 bg-gray-900" style={{ left: `${ATS_BADGE_THRESHOLD}%` }}>
        <span className="absolute top-full mt-1 left-1/2 -translate-x-1/2 text-[11px] font-medium text-gray-500 whitespace-nowrap">Verified {ATS_BADGE_THRESHOLD}</span>
      </div>
    </div>
  )
}
