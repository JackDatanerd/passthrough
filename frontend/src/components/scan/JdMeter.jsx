import { jdLength, MAX_JD_CHARS, MIN_JD_CHARS } from './useScanForm'
import { formatNumber, cn } from '../../lib/utils'

// How much job text there is, said in the person's terms: short is red and says how many more, thin is amber, a full posting is
// green. One component for the /scan page and the homepage card, so the two cannot say different things about the same text.
export function jdMeter(count) {
  if (count < MIN_JD_CHARS) return { tone: 'bad', msg: count === 0 ? `Paste the posting, at least ${MIN_JD_CHARS} characters` : `${MIN_JD_CHARS - count} more characters needed`, pct: Math.max(3, (count / MIN_JD_CHARS) * 30) }
  if (count < 400) return { tone: 'mid', msg: 'Works, but a full posting scores more accurately', pct: 30 + (count / 400) * 30 }
  if (count > MAX_JD_CHARS) return { tone: 'mid', msg: 'Long. We trim the intro and benefits, keep the requirements. Your result shows what was scored.', pct: 100 }
  return { tone: 'ok', msg: 'Looks like a full posting', pct: Math.min(100, 60 + (count / MAX_JD_CHARS) * 40) }
}
const TONE = { bad: ['text-red-700', 'bg-red-500'], mid: ['text-amber-700', 'bg-amber-500'], ok: ['text-green-700', 'bg-green-600'] }

export default function JdMeter({ text }) {
  const count = jdLength(text)
  const m = jdMeter(count)
  const [textCls, barCls] = TONE[m.tone]
  return (
    <>
      <div aria-hidden="true" className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-100"><i className={cn('block h-full transition-[width,background-color] duration-200', barCls)} style={{ width: `${m.pct}%` }} /></div>
      <div className="mt-1.5 flex justify-between gap-2.5 text-xs">
        <span data-testid="jd-meter-msg" className={cn('font-medium', textCls)}>{m.msg}</span>
        <span className={cn('tabular-nums', count > MAX_JD_CHARS ? 'font-medium text-amber-700' : 'text-gray-500')}>{formatNumber(count)} / {formatNumber(MAX_JD_CHARS)}</span>
      </div>
      <span className="sr-only">{count >= MIN_JD_CHARS ? 'Enough to score' : 'Too short'}</span>
    </>
  )
}
