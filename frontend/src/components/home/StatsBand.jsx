import useReveal, { useCountUp } from '../../hooks/useReveal'
import { splitScanCount, monthYear } from '../../lib/homeFormat'

function CountStat({ value, suffix = '', label, active }) {
  const n = useCountUp(value, active)
  return (
    <div>
      <div className="text-4xl sm:text-5xl font-extrabold tracking-tight leading-none tabular-nums">{n.toLocaleString('en-US')}{suffix}</div>
      <div className="mt-2 text-sm text-blue-200">{label}</div>
    </div>
  )
}

export default function StatsBand({ data, badgeThreshold }) {
  const [ref, shown] = useReveal({ threshold: 0.4 })
  const count = splitScanCount(data.scans.value, { atLeast: data.scans.isFallback })
  const rate = data.rate
  const since = rate.since ? monthYear(rate.since) : null

  return (
    <section ref={ref} aria-label="Passthrough by the numbers" className="bg-blue-900 text-white py-11">
      <div className="max-w-5xl mx-auto px-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-x-5 gap-y-8 text-center">
          {count && <CountStat value={count.value} suffix={count.plus ? '+' : ''} label="resumes scanned" active={shown} />}
          {rate.pct != null && <CountStat value={rate.pct} suffix="%" label="of applicants report an interview*" active={shown} />}
          <div>
            <div className="text-4xl sm:text-5xl font-extrabold tracking-tight leading-none">~30s</div>
            <div className="mt-2 text-sm text-blue-200">to your full score breakdown</div>
          </div>
          <div>
            <div className="text-4xl sm:text-5xl font-extrabold tracking-tight leading-none">{badgeThreshold}+</div>
            <div className="mt-2 text-sm text-blue-200">score needed to earn the Verified credential</div>
          </div>
        </div>
        {rate.pct != null && (
          <p className="mt-7 text-center text-xs text-blue-300">
            *Self-reported by applicants who answered our follow-up after their fixed resume was delivered
            {!rate.isFallback && rate.responses ? <>, based on {rate.responses.toLocaleString('en-US')} responses{since ? ` since ${since}` : ''}</> : null}.
            Not a guarantee of any outcome. <a href="#faq-66" className="underline text-white">How we calculate this</a>
          </p>
        )}
      </div>
    </section>
  )
}
