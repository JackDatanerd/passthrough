import { ATS_PASS_THRESHOLD, ATS_BADGE_THRESHOLD } from '../../lib/scoreThresholds'
import ScoreRoad from './ScoreRoad'

// The Score tab's first card: the number as a ring, one plain sentence about where it stands, and the road with the two lines
// that matter (the pass mark and the Verified line). Presentation only; every number comes from the server's scan.
export default function ScoreSummary({ score, passed }) {
  const has = typeof score === 'number'
  const r = 50, c = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(100, has ? score : 0)) / 100
  const isPass = passed ?? (has && score >= ATS_PASS_THRESHOLD)
  const color = isPass ? '#16a34a' : has && score >= 50 ? '#F59E0B' : '#dc2626'
  const toBadge = has ? ATS_BADGE_THRESHOLD - score : 0
  const belowPass = has ? ATS_PASS_THRESHOLD - score : 0
  const sentence = !has ? '' : toBadge <= 0
    ? `You are over the ${ATS_BADGE_THRESHOLD} that earns a Verified link.`
    : `${toBadge} point${toBadge === 1 ? '' : 's'} from the ${ATS_BADGE_THRESHOLD} that earns a Verified link${belowPass > 0 ? `, ${belowPass} below the usual pass mark` : ''}.`
  return (
    <div data-testid="score-summary" className="rounded-2xl border border-gray-200 bg-white p-[18px] shadow-[0_1px_2px_rgba(10,21,48,.04)]">
      <div className="flex flex-wrap items-center gap-[18px]">
        <div className="relative h-[118px] w-[118px] flex-none">
          <svg width="118" height="118" viewBox="0 0 118 118" aria-hidden="true" className="-rotate-90">
            <circle cx="59" cy="59" r={r} fill="none" stroke="#E5E7EB" strokeWidth="11" />
            <circle cx="59" cy="59" r={r} fill="none" stroke={color} strokeWidth="11" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct)} style={{ transition: 'stroke-dashoffset .6s ease' }} />
          </svg>
          <div className="absolute inset-0 grid place-content-center text-center">
            <b className="font-display text-4xl font-extrabold leading-none text-ink">{has ? score : ''}</b>
            <span className="text-[11px] text-gray-500">out of 100</span>
          </div>
        </div>
        <div className="min-w-[200px] flex-1">
          <h2 className="mb-1 font-display text-lg font-extrabold tracking-[-0.02em] text-ink">{isPass ? 'Your resume passed ATS screening' : 'Your resume is failing ATS filters'}</h2>
          {sentence && <p className="text-sm text-gray-600">{sentence}</p>}
        </div>
      </div>
      <ScoreRoad after={score} />
    </div>
  )
}
