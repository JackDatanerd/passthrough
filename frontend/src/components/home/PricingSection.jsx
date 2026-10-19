import { useState } from 'react'
import { Link } from 'react-router-dom'
import PromoCountdown from '../ui/PromoCountdown'
import { fmtPrice } from '../../hooks/usePricing'
import { ATS_PASS_THRESHOLD } from '../../lib/scoreThresholds'

// Every number here comes from /api/pricing (usePricing falls back internally to the standard prices): the
// amounts, the struck-through anchors, the promo deadline, the Verified threshold, the retry count and
// whether duplicate-charge refunds are on. The pass line (75) is the only constant: the API does not serve it.
//
// The score picker is the page's one piece of personalisation: slide to the score your scan came back at and
// the plan that fits is marked, the one that cannot apply (Credential only below the threshold) is locked
// and says why. It changes nothing about what is sold or charged.
function Price({ tier, currency, size = 'text-4xl' }) {
  const onSale = tier.amount !== tier.originalAmount
  return (
    <div className="flex items-baseline gap-2 mb-1">
      {onSale && <s className="text-lg text-gray-400">{fmtPrice(tier.originalAmount, currency)}</s>}
      <b className={`${size} font-extrabold tracking-tight text-gray-900`}>{fmtPrice(tier.amount, currency)}</b>
    </div>
  )
}

function Features({ items }) {
  return (
    <ul className="flex flex-col gap-2 mb-5 text-sm text-gray-700">
      {items.map(([ok, text]) => (
        <li key={text} className={ok ? '' : 'text-gray-400'}>
          <span aria-hidden="true" className={`font-extrabold mr-2 ${ok ? 'text-green-600' : 'text-gray-400'}`}>{ok ? '✓' : '–'}</span>
          <span className="sr-only">{ok ? 'Included: ' : 'Not included: '}</span>{text}
        </li>
      ))}
    </ul>
  )
}

const FitPill = () => <span className="self-start font-mono text-[11px] font-bold uppercase tracking-wide bg-blue-700 text-white px-2 py-0.5 rounded mb-2.5">Fits your score</span>
const ghostBtn = 'mt-auto block text-center font-semibold rounded-lg border border-blue-200 text-blue-800 bg-white px-4 py-2.5 hover:bg-blue-50'
const cardBase = 'relative bg-white rounded-xl border shadow-sm p-6 flex flex-col transition-[opacity,box-shadow,border-color]'

function ScorePicker({ score, setScore, pass, badge }) {
  const pctPass = Math.min(Math.max(pass, 0), 100)
  const pctBadge = Math.min(Math.max(badge, pctPass), 100)
  let why
  if (score < pass) why = <>Below the pass line. <b>Full fix</b> rewrites your resume toward the job and adds the credential once it clears {badge}. Fix only is the same rewrite without the link. Credential only needs a score of {badge} or higher, so it&apos;s locked for now.</>
  else if (score < badge) why = <>You pass, but you&apos;re {badge - score} point{badge - score === 1 ? '' : 's'} short of the credential. <b>Full fix</b> is built to close that gap and issue the link. Credential only unlocks at {badge}.</>
  else why = <>You&apos;re already credential-eligible. <b>Credential only</b> is the cheapest way to get the receipt. Choose Full fix if you also want the rewrite.</>
  const colour = score < pass ? 'text-red-700' : score < badge ? 'text-amber-800' : 'text-green-700'
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 mb-7">
      <div className="flex justify-between items-baseline gap-4 flex-wrap">
        <h3 className="text-lg font-bold text-gray-900">If your scan comes back at…</h3>
        <div className={`text-5xl font-extrabold leading-none tracking-tighter ${colour}`} aria-hidden="true">{score}</div>
      </div>
      <input type="range" min="0" max="100" value={score} onChange={e => setScore(Number(e.target.value))} aria-label="Your ATS score" aria-valuetext={`${score} out of 100`}
        className="w-full my-3 accent-blue-700" />
      <div aria-hidden="true" className="flex gap-0.5 font-mono text-[11px] font-semibold uppercase tracking-wide">
        <span className="bg-red-50 text-red-700 rounded px-1.5 py-1 text-center whitespace-nowrap overflow-hidden text-ellipsis" style={{ flex: `${pctPass} 1 0` }}><span className="sm:hidden">Fails</span><span className="hidden sm:inline">Below {pass}: fails</span></span>
        {pctBadge > pctPass && <span className="bg-amber-50 text-amber-800 rounded py-1 text-center overflow-hidden" style={{ flex: `${pctBadge - pctPass} 1 0` }}>{pass}</span>}
        <span className="bg-green-50 text-green-700 rounded px-1.5 py-1 text-center whitespace-nowrap overflow-hidden text-ellipsis" style={{ flex: `${100 - pctBadge} 1 0` }}><span className="sm:hidden">{badge}+</span><span className="hidden sm:inline">{badge}+: credential</span></span>
      </div>
      <p aria-live="polite" className="mt-3.5 text-[15.5px] text-gray-700">{why}</p>
    </div>
  )
}

export default function PricingSection({ pricing, byTier, refresh, clockOffsetMs, referralCode, limits }) {
  const [score, setScore] = useState(72)
  const currency = pricing?.currency
  const fix = byTier('FIX'), plain = byTier('FIX_PLAIN'), badge = byTier('BADGE')
  const saving = fix.originalAmount - fix.amount
  const premium = fix.amount - plain.amount
  const anyDiscount = !!referralCode && [fix, plain, badge].some(t => t.discountApplied)
  const { badgeThreshold, maxFixRetries, freeScansPerDay, anonScansPerHour } = limits
  const rec = score >= badgeThreshold ? 'badge' : 'full'
  const locked = score < badgeThreshold
  const ring = (id) => (rec === id ? 'border-blue-700 ring-4 ring-blue-100' : 'border-gray-200')

  return (
    <section id="pricing" className="bg-gray-50 border-y border-gray-100 py-[72px] scroll-mt-4">
      <div className="max-w-6xl mx-auto px-4">
        <div className="text-center max-w-2xl mx-auto mb-7">
          <p className="text-xs font-bold uppercase tracking-wider text-blue-700 mb-2">Pricing</p>
          <h2 className="text-3xl font-bold text-gray-900 mb-3">One payment. No subscription.</h2>
          <p className="text-gray-500 text-[17px]">You&apos;ll see your score before you spend anything. The right plan depends on it, so slide the score to see which one fits.</p>
        </div>

        {pricing?.promoActive && pricing.promoEndsAt && (
          <div className="flex justify-center mb-6">
            <PromoCountdown endsAt={pricing.promoEndsAt} clockOffsetMs={clockOffsetMs} onExpire={refresh} />
          </div>
        )}
        {anyDiscount && <p className="text-center text-sm text-emerald-700 mb-6">✓ Your referral discount is applied to the prices below.</p>}

        <ScorePicker score={score} setScore={setScore} pass={ATS_PASS_THRESHOLD} badge={badgeThreshold} />

        <div className="grid sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1.18fr_1fr] gap-4 items-stretch">
          <div className={`${cardBase} border-gray-200`}>
            <div className="text-sm font-semibold text-gray-500 mb-1.5">Free forever</div>
            <div className="mb-1"><b className="text-4xl font-extrabold tracking-tight text-gray-900">{fmtPrice(0, currency)}</b></div>
            <p className="text-sm text-gray-500 mb-4">Know where you stand.</p>
            <Features items={[
              [true, 'Full score breakdown'],
              [true, `${anonScansPerHour} scan${anonScansPerHour === 1 ? '' : 's'}/hour, no account`],
              [true, `${freeScansPerDay}/day with a free account`],
              [false, 'AI rewrite'], [false, 'Verified credential'],
            ]} />
            <a href="#scan-form" className={ghostBtn}>Scan free</a>
          </div>

          <div data-plan="badge" data-fit={rec === 'badge' ? 'true' : undefined} data-locked={locked ? 'true' : undefined} className={`${cardBase} ${ring('badge')} ${locked ? 'opacity-60' : ''}`}>
            <div className="text-sm font-semibold text-gray-500 mb-1.5">Credential only</div>
            {rec === 'badge' && <FitPill />}
            <Price tier={badge} currency={currency} />
            <p className="text-sm text-gray-500 mb-4">Already scoring {badgeThreshold}+? Prove it.</p>
            <Features items={[[true, 'Passthrough Verified link & badge'], [true, 'Integrity check for employers'], [true, 'Bonus: tailored cover letter'], [false, 'No rewrite']]} />
            {locked && <p className="text-[12.5px] font-bold text-amber-800 mb-2.5">Unlocks at a score of {badgeThreshold}+</p>}
            {locked
              ? <span aria-disabled="true" className="mt-auto block text-center font-semibold rounded-lg border border-gray-200 bg-gray-100 text-gray-500 px-4 py-2.5 cursor-not-allowed">Needs a score of {badgeThreshold}+</span>
              : <Link to="/pricing" className={ghostBtn}>Get credential</Link>}
          </div>

          <div data-plan="full" data-fit={rec === 'full' ? 'true' : undefined} className={`relative bg-gradient-to-b from-white to-blue-50 rounded-xl border-2 border-blue-700 shadow-xl p-6 flex flex-col mt-3 sm:mt-0 order-first sm:col-span-2 lg:order-none lg:col-span-1 lg:-translate-y-2 ${rec === 'full' ? 'ring-4 ring-blue-100' : ''}`}>
            <span className="absolute -top-3.5 left-1/2 -translate-x-1/2 bg-blue-700 text-white text-xs font-bold px-3.5 py-1 rounded-full whitespace-nowrap">Most popular · best value</span>
            <div className="text-sm font-semibold text-blue-700 mb-1.5">Full fix</div>
            {rec === 'full' && <FitPill />}
            <Price tier={fix} currency={currency} size="text-5xl" />
            {saving > 0 && <span className="self-start text-xs font-bold text-green-800 bg-green-100 rounded-full px-2.5 py-0.5 mb-2">You save {fmtPrice(saving, currency)} today</span>}
            <p className="text-sm text-gray-600 mb-3">Fix it <strong>and</strong> prove it. Any starting score.</p>
            {premium > 0 && <p className="text-xs text-blue-800 bg-blue-100 rounded-lg px-2.5 py-2 mb-3.5">Only {fmtPrice(premium, currency)} more than Fix only — and it adds the link employers can check.</p>}
            <Features items={[
              [true, 'AI rewrite, re-scored against the job'], [true, 'ATS-ready .docx + PDF'], [true, 'Passthrough Verified link & badge'],
              [true, 'Bonus: tailored cover letter'],
              [true, `${maxFixRetries} free retries + a free-credit safety net`],
            ]} />
            <a href="#scan-form" className="mt-auto block text-center font-semibold rounded-lg bg-blue-700 text-white px-4 py-3 hover:bg-blue-800 shadow">Fix &amp; verify my resume →</a>
          </div>

          <div className={`${cardBase} border-gray-200`}>
            <div className="text-sm font-semibold text-gray-500 mb-1.5">Fix only</div>
            <Price tier={plain} currency={currency} />
            <p className="text-sm text-gray-500 mb-4">Just the rewrite.</p>
            <Features items={[[true, 'AI rewrite + ATS .docx + PDF'], [true, 'Bonus: tailored cover letter'], [true, 'Any starting score'], [false, 'No verification link']]} />
            <a href="#scan-form" className={ghostBtn}>Fix only</a>
          </div>
        </div>

        <div className="mt-8 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 bg-white border-2 border-dashed border-blue-300 rounded-xl p-5">
          <span className="self-start font-mono text-[11px] font-bold uppercase tracking-wide bg-blue-700 text-white px-2 py-0.5 rounded whitespace-nowrap">New · bonus</span>
          <div>
            <h3 className="text-lg font-bold text-gray-900">A tailored cover letter comes with every paid plan.</h3>
            <p className="text-sm text-gray-600">Written from your delivered resume and the job you scanned against. Pick the tone and who it&apos;s addressed to, edit it, then download it as .docx or PDF. No extra charge.</p>
          </div>
        </div>

        <div className="mt-5 grid sm:grid-cols-[auto_1fr] gap-4 items-start bg-blue-700 text-white rounded-xl p-6">
          <div aria-hidden="true" className="w-11 h-11 rounded-xl bg-white/15 flex items-center justify-center">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 2.5 4.5 5.3v5.4c0 4.6 3.2 8.2 7.5 10.8 4.3-2.6 7.5-6.2 7.5-10.8V5.3L12 2.5Z" stroke="#fff" strokeWidth="1.8" strokeLinejoin="round" /><path d="m8.6 12 2.4 2.4 4.4-4.6" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </div>
          <div>
            <h3 className="text-xl font-bold mb-1">Included with every fix: free retries and a safety net.</h3>
            <p className="text-blue-100 text-sm">Multiple AI rewrite attempts, {maxFixRetries} free manual retries, and if those still don&apos;t get you past the verification threshold, a free credit for your next resume.</p>
            <ul className="grid gap-1 mt-3 text-sm font-semibold">
              <li>✓ Multiple AI rewrite attempts</li><li>✓ {maxFixRetries} free manual retries</li><li>✓ A free credit if those still don&apos;t get you there</li>
              {pricing?.autoRefundDuplicates && <li>✓ Charged twice? The extra payment is refunded automatically</li>}
            </ul>
          </div>
        </div>
        <p className="text-center mt-5 text-sm">
          <Link to="/pricing" className="font-medium text-blue-700 hover:text-blue-800 underline underline-offset-2">See full pricing details →</Link>
        </p>
      </div>
    </section>
  )
}
