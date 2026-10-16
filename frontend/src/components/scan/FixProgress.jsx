import ResumeSheet from './ResumeSheet'
import ProgressSteps from './ProgressSteps'
import useElapsedSeconds, { currentStep } from '../../hooks/useElapsedSeconds'

// Fix wait (FIX_PURCHASED / FIX_GENERATING). Same page, same steps list, green beam:
// the fix reads as a second chapter of the scan, not a new wait. Time-paced; the last
// step is held open until the server delivers.
const FIX_STEPS = [
  ['Reading your scan', 'Starting from what we found'],
  ['Rewriting weak lines', 'Same facts, clearer wording'],
  ['Building your files', 'Word and PDF'],
  ['Scoring the real file', 'Stays open until the result is ready'],
]
const BADGE_STEPS = [
  ['Reading your scan', 'Starting from what we found'],
  ['Formatting your resume', 'A clean single-column layout'],
  ['Building your files', 'Word and PDF'],
  ['Scoring the real file', 'Stays open until the result is ready'],
]
export const FIX_STEP_STARTS = [0, 10, 35, 65]

export default function FixProgress({ tier, startedAt, children }) {
  const elapsed = useElapsedSeconds(startedAt)
  const badge = tier === 'BADGE'
  return (
    <div className="bg-blue-50 border border-blue-200 rounded-xl p-6" role="status" aria-live="polite">
      <div className="flex gap-5">
        <ResumeSheet elapsedSeconds={elapsed} tone="green" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-blue-900">
            {badge ? 'Verifying and formatting your resume…' : 'Generating your fixed resume…'}
          </p>
          <p className="text-sm text-blue-700 mt-0.5">
            You can leave this page. We'll email you when it's ready. Usually under 2 minutes.
          </p>
          <ProgressSteps steps={badge ? BADGE_STEPS : FIX_STEPS} current={currentStep(elapsed, FIX_STEP_STARTS)} />
        </div>
      </div>
      {children}
    </div>
  )
}
