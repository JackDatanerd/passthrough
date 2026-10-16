import ResumeSheet from './ResumeSheet'
import ProgressSteps from './ProgressSteps'
import useElapsedSeconds, { currentStep } from '../../hooks/useElapsedSeconds'

// Scan wait. The API reports only PENDING/SCANNING today, so the steps are
// time-paced and the LAST step stays open until the server says the scan is done.
export const SCAN_STEPS = [
  ['Reading your file', 'Text, columns and tables'],
  ['Pulling out sections', 'Skills, experience, education'],
  ['Matching the job', 'Keywords and seniority'],
  ['Scoring', 'Stays open until the result is ready'],
]
export const SCAN_STEP_STARTS = [0, 6, 13, 20]

function fmt(s) { const n = Math.floor(s); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}` }

// `leaveNote` is decided by the caller, because only the caller knows whether a
// result email will really be sent (it is not, for a plain anonymous upload).
export default function ScanProgress({ createdAt, leaveNote, children }) {
  const elapsed = useElapsedSeconds(createdAt)
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm" role="status" aria-live="polite">
      <div className="flex gap-5">
        <ResumeSheet elapsedSeconds={elapsed} tone="blue" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <p className="font-medium text-gray-800">Scanning your resume…</p>
            <span className="text-xs tabular-nums text-gray-400" data-testid="scan-elapsed">{fmt(elapsed)}</span>
          </div>
          <p className="text-sm text-gray-500 mt-0.5">Usually about 30 seconds.</p>
          <ProgressSteps steps={SCAN_STEPS} current={currentStep(elapsed, SCAN_STEP_STARTS)} />
        </div>
      </div>
      {leaveNote && <p className="text-xs text-gray-500 mt-4 border-t border-gray-100 pt-3">{leaveNote}</p>}
      {children}
    </div>
  )
}
