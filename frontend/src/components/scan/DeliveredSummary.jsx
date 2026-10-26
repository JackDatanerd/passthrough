import ScoreRoad from './ScoreRoad'
import AttemptChips from './AttemptChips'
import { liveProgress } from './FixProgress'
import { ATS_BADGE_THRESHOLD } from '../../lib/scoreThresholds'

// The picture at the top of a delivered fix: where the score started, where it landed, and, when the server recorded
// them, the real attempts it took to get there (scan.fixProgress, migration 0088). Shown only for a real rewrite: a
// badge-only delivery rewrote nothing, and a failed rewrite delivered the original, so neither has a "before and after".
export default function DeliveredSummary({ scan }) {
  if (!scan || scan.rewriteFailed || scan.fixTier === 'BADGE') return null
  const after = scan.fixAtsScore, before = scan.atsScore
  if (typeof after !== 'number') return null
  const live = liveProgress(scan.fixProgress, scan.fixRetryCount)
  const scores = live && Array.isArray(live.scores) ? live.scores.filter(n => typeof n === 'number') : []
  const plain = scan.fixTier === 'FIX_PLAIN'            // a plain fix has no credential, so no credential line to be "past"
  const gap = ATS_BADGE_THRESHOLD - after
  const delta = typeof before === 'number' ? after - before : null
  // A paid retry keeps the earlier result when none of this round's attempts beat it; say so, or the ladder would
  // look lower than the score that was delivered.
  const keptEarlier = scan.fixRetryCount > 0 && scores.length > 0 && Math.max(...scores) < after

  return (
    <div className="mb-4" data-testid="delivered-summary">
      <p className="text-sm text-gray-700">
        {gap > 0 && !plain
          ? <><strong>{after}</strong> out of 100, {gap} point{gap === 1 ? '' : 's'} from the {ATS_BADGE_THRESHOLD}.</>
          : <><strong>{after}</strong> out of 100{plain ? '.' : <>, past the {ATS_BADGE_THRESHOLD} line.</>}</>}
        {delta !== null && delta > 0 && <> Up {delta} from {before}.</>}
      </p>
      <ScoreRoad before={before} after={after} />
      {scores.length > 0 && (
        <div className="mt-1">
          <AttemptChips scores={scores} testId="delivered-attempts" />
          {keptEarlier && (
            <p className="text-xs text-gray-600 mt-2" data-testid="kept-earlier">
              None of this round's attempts beat your earlier result, so you kept that one.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
