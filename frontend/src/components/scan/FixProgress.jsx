import PassAnim from './PassAnim'
import ProgressSteps from './ProgressSteps'
import AttemptChips from './AttemptChips'
import useElapsedSeconds, { currentStep, gateStep } from '../../hooks/useElapsedSeconds'
import { ATS_BADGE_THRESHOLD } from '../../lib/scoreThresholds'

// Fix wait (FIX_PURCHASED / FIX_GENERATING). Same page, same steps list, green beam: the fix reads as a second chapter of
// the scan, not a new wait. The steps are time-paced; when the server reports where the job really is (scan.fixProgress,
// migration 0088) that report narrows the clock's guess, and the attempt scores become a real ladder. The last step is held
// open until the server delivers.
const FIX_STEPS = [
  ['Reading your scan', 'Starting from what we found'],
  ['Rewriting weak lines', 'Same facts, clearer wording'],
  ['Scoring the real file', 'The Word file, read the way an ATS reads it'],
  ['Preparing your files', 'Word and PDF. Stays open until the result is ready'],
]
const BADGE_STEPS = [
  ['Reading your scan', 'Starting from what we found'],
  ['Formatting your resume', 'A clean single-column layout'],
  ['Scoring the real file', 'The Word file, read the way an ATS reads it'],
  ['Preparing your files', 'Word and PDF. Stays open until the result is ready'],
]
export const FIX_STEP_STARTS = [0, 10, 35, 65]
// phase -> [floor, ceiling] step index. The badge-only flow reports just 'starting' and 'rendering'.
export const FIX_PHASE_GATES = { starting: [0, 1], rewriting: [1, 1], scoring: [2, 2], rendering: [3, 3] }
export const BADGE_PHASE_GATES = { starting: [0, 1], rendering: [1, 3] }

// Progress only counts when it belongs to THIS paid round: a retry flips the scan back to generating while the previous
// round's progress is still on the row, so a mismatched `round` is ignored until the new run writes its own.
export function liveProgress(progress, round) {
  if (!progress || typeof progress !== 'object') return null
  if ((progress.round ?? 0) !== (round ?? 0)) return null
  return progress
}

export default function FixProgress({ tier, startedAt, progress, round, children }) {
  const live = liveProgress(progress, round)
  const elapsed = useElapsedSeconds(live?.startedAt || startedAt)
  const badge = tier === 'BADGE'
  const gates = badge ? BADGE_PHASE_GATES : FIX_PHASE_GATES
  const current = gateStep(currentStep(elapsed, FIX_STEP_STARTS), live ? gates[live.phase] : undefined)
  const scores = live && Array.isArray(live.scores) ? live.scores.filter(n => typeof n === 'number') : []
  const retrying = !!live && live.phase === 'rewriting' && scores.length > 0
  return (
    <div className="max-w-[600px] rounded-xl border border-gray-200 bg-white p-[22px] shadow-sm" role="status" aria-live="polite">
      <PassAnim tone="green" />
      <h2 className="text-lg font-semibold text-gray-900">
        {badge ? 'Verifying and formatting your resume…' : 'Writing your fixed resume…'}
      </h2>
      <p className="mt-1 text-sm text-gray-600">
        You can leave this page. We'll email you when it's ready. Usually under 2 minutes.
      </p>
      <ProgressSteps steps={badge ? BADGE_STEPS : FIX_STEPS} current={current} />
      {(scores.length > 0 || retrying) && (
        <div className="mt-3.5">
          <AttemptChips scores={scores} working={retrying ? `Attempt ${live.attempt}: rewriting\u2026` : null} />
          {retrying && (
            <p className="mt-2 text-xs text-gray-600">
              Aiming for {ATS_BADGE_THRESHOLD}+. The next attempt starts from what the last one missed.
            </p>
          )}
        </div>
      )}
      {children}
    </div>
  )
}
