import PassAnim from './PassAnim'
import ProgressSteps from './ProgressSteps'
import useElapsedSeconds, { currentStep, gateStep } from '../../hooks/useElapsedSeconds'

// Scan wait. The API reports only PENDING/SCANNING today, so the steps are
// time-paced and the LAST step stays open until the server says the scan is done.
export const SCAN_STEPS = [
  ['Reading your file', 'Text, columns and tables'],
  ['Pulling out sections', 'Skills, experience, education'],
  ['Matching the job', 'Keywords and seniority'],
  ['Scoring', 'Stays open until the result is ready'],
]
export const SCAN_STEP_STARTS = [0, 6, 13, 20]
// scan.scanStage (migration 0088): 'reading' = fetching and reading the file; 'scoring' = text is ready, rules + AI are scoring.
export const SCAN_STAGE_GATES = { reading: [0, 1], scoring: [2, 3] }

function fmt(s) { const n = Math.floor(s); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}` }

// `leaveNote` is decided by the caller, because only the caller knows whether a
// result email will really be sent (it is not, for a plain anonymous upload).
export default function ScanProgress({ createdAt, stage, leaveNote, children }) {
  const elapsed = useElapsedSeconds(createdAt)
  return (
    <div className="max-w-[560px] rounded-2xl border border-gray-200 bg-white p-[22px] shadow-[0_1px_2px_rgba(10,21,48,.04)]" role="status" aria-live="polite">
      <PassAnim tone="blue" />
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-lg font-extrabold tracking-[-0.02em] text-ink">Scanning your resume…</h2>
        <span className="text-xs tabular-nums text-gray-400" data-testid="scan-elapsed">{fmt(elapsed)}</span>
      </div>
      <p className="mt-1 text-sm text-gray-600">Usually about 30 seconds.</p>
      {leaveNote && <p className="mt-1 text-sm text-gray-600">{leaveNote}</p>}
      <ProgressSteps steps={SCAN_STEPS} current={gateStep(currentStep(elapsed, SCAN_STEP_STARTS), SCAN_STAGE_GATES[stage])} />
      {children}
    </div>
  )
}
