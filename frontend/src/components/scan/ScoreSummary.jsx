import { ATS_PASS_THRESHOLD, ATS_BADGE_THRESHOLD } from '../../lib/scoreThresholds'
import ScoreRing from '../dashboard/ScoreRing'
import ScoreRoad from './ScoreRoad'

// The Score tab's first card: the number as the app's own score ring, one plain sentence about where it stands, and the road with
// the two lines that matter (the pass mark and the Verified line). Presentation only; every number comes from the server's scan.
// `provisional`: the AI half of the check was unavailable, so the number may read low. The card then says what it can honestly say
// (the score so far), not that the resume is failing.
// `original`: something has been bought, so this card is where the person STARTED. It says so (a delivered 86 sits right above it)
// instead of calling the resume failing. { after: the delivered score or null, rewrote: whether the purchase rewrote the resume }.
export default function ScoreSummary({ score, passed, provisional = false, original = null }) {
  const has = typeof score === 'number' && Number.isFinite(score)
  const isPass = passed ?? (has && score >= ATS_PASS_THRESHOLD)
  const band = !has ? 'none' : isPass ? 'good' : score >= 50 ? 'mid' : 'low'
  const toBadge = has ? ATS_BADGE_THRESHOLD - score : 0
  const belowPass = has ? ATS_PASS_THRESHOLD - score : 0
  const sentence = !has ? '' : toBadge <= 0
    ? `You are over the ${ATS_BADGE_THRESHOLD} that earns a Verified link.`
    : `${toBadge} point${toBadge === 1 ? '' : 's'} from the ${ATS_BADGE_THRESHOLD} that earns a Verified link${belowPass > 0 ? `, ${belowPass} below the usual pass mark` : ''}.`
  const headline = original && has ? 'Your original scan' : !has ? 'No score yet' : provisional ? 'Your score so far' : isPass ? 'Your resume passed ATS screening' : 'Your resume is failing ATS filters'
  const originalSentence = !original ? null
    : typeof original.after === 'number' ? (original.rewrote ? `Where you started. After the fix: ${original.after}.` : `Your scan before verification. The file we delivered scored ${original.after}.`)
      : 'Where you started. Your result is on Your resume.'
  return (
    <div data-testid="score-summary" className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center gap-5">
        <ScoreRing score={has ? score : null} size="xl" band={band} />
        <div className="min-w-[200px] flex-1">
          <h2 className="mb-1 text-lg font-semibold text-gray-900">{headline}</h2>
          {(originalSentence || sentence) && <p className="text-sm text-gray-600">{originalSentence || sentence}</p>}
        </div>
      </div>
      <ScoreRoad after={has ? score : null} />
    </div>
  )
}
