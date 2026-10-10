import { Link } from 'react-router-dom'
import PromoCountdown from '../ui/PromoCountdown'
import { fmtPrice } from '../../hooks/usePricing'

// Every number here comes from /api/pricing (usePricing falls back internally to the standard prices):
// the amounts, the struck-through anchors, the promo deadline, the thresholds and the retry count. The
// "Full fix" card is the visual anchor: it is the only tier that fixes AND proves, and its price is
// framed against the plain fix next to it ("only $X more").
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

const ghostBtn = 'mt-auto block text-center font-semibold rounded-lg border border-blue-200 text-blue-800 bg-white px-4 py-2.5 hover:bg-blue-50'

export default function PricingSection({ pricing, byTier, refresh, clockOffsetMs, referralCode, limits }) {
  const currency = pricing?.currency
  const fix = byTier('FIX'), plain = byTier('FIX_PLAIN'), badge = byTier('BADGE')
  const saving = fix.originalAmount - fix.amount
  const premium = fix.amount - plain.amount
  const anyDiscount = !!referralCode && [fix, plain, badge].some(t => t.discountApplied)
  const { badgeThreshold, maxFixRetries, freeScansPerDay, anonScansPerHour } = limits

  return (
    <section id="pricing" className="bg-gray-50 border-y border-gray-100 py-16 scroll-mt-4">
      <div className="max-w-6xl mx-auto px-4">
        <div className="text-center max-w-2xl mx-auto mb-7">
          <p className="text-xs font-bold uppercase tracking-wider text-blue-700 mb-2">Pricing</p>
          <h2 className="text-3xl font-bold text-gray-900 mb-3">One payment. No subscription.</h2>
          <p className="text-gray-500">You&apos;ll see your score before you spend anything.</p>
        </div>

        {pricing?.promoActive && pricing.promoEndsAt && (
          <div className="flex justify-center mb-6">
            <PromoCountdown endsAt={pricing.promoEndsAt} clockOffsetMs={clockOffsetMs} onExpire={refresh} />
          </div>
        )}
        {anyDiscount && <p className="text-center text-sm text-emerald-700 mb-6">✓ Your referral discount is applied to the prices below.</p>}

        <div className="grid sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1.18fr_1fr] gap-4 items-stretch">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 flex flex-col">
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

          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 flex flex-col">
            <div className="text-sm font-semibold text-gray-500 mb-1.5">Credential only</div>
            <Price tier={badge} currency={currency} />
            <p className="text-sm text-gray-500 mb-4">Already scoring {badgeThreshold}+? Prove it.</p>
            <Features items={[[true, 'Passthrough Verified link & badge'], [true, 'Integrity check for employers'], [false, 'No rewrite']]} />
            <Link to="/pricing" className={ghostBtn}>Get credential</Link>
          </div>

          <div className="relative bg-gradient-to-b from-white to-blue-50 rounded-xl border-2 border-blue-700 shadow-xl p-6 flex flex-col lg:-translate-y-2">
            <span className="absolute -top-3.5 left-1/2 -translate-x-1/2 bg-blue-700 text-white text-xs font-bold px-3.5 py-1 rounded-full whitespace-nowrap">Most popular · best value</span>
            <div className="text-sm font-semibold text-blue-700 mb-1.5">Full fix</div>
            <Price tier={fix} currency={currency} size="text-5xl" />
            {saving > 0 && <span className="self-start text-xs font-bold text-green-800 bg-green-100 rounded-full px-2.5 py-0.5 mb-2">You save {fmtPrice(saving, currency)} today</span>}
            <p className="text-sm text-gray-600 mb-3">Fix it <strong>and</strong> prove it. Any starting score.</p>
            {premium > 0 && <p className="text-xs text-blue-800 bg-blue-100 rounded-lg px-2.5 py-2 mb-3.5">Only {fmtPrice(premium, currency)} more than Fix only — and it adds the link employers actually trust.</p>}
            <Features items={[
              [true, 'AI rewrite, re-scored until it passes'], [true, 'ATS-ready .docx + PDF'], [true, 'Passthrough Verified link & badge'],
              [true, `${maxFixRetries} free retries + fix-credit guarantee`],
            ]} />
            <a href="#scan-form" className="mt-auto block text-center font-semibold rounded-lg bg-blue-700 text-white px-4 py-3 hover:bg-blue-800 shadow">Fix &amp; verify my resume →</a>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 flex flex-col">
            <div className="text-sm font-semibold text-gray-500 mb-1.5">Fix only</div>
            <Price tier={plain} currency={currency} />
            <p className="text-sm text-gray-500 mb-4">Just the rewrite.</p>
            <Features items={[[true, 'AI rewrite + ATS .docx + PDF'], [true, 'Any starting score'], [false, 'No verification link']]} />
            <a href="#scan-form" className={ghostBtn}>Fix only</a>
          </div>
        </div>

        <div className="mt-8 grid sm:grid-cols-[auto_1fr] gap-5 items-center bg-blue-700 text-white rounded-xl p-6">
          <div aria-hidden="true" className="text-4xl">🛡️</div>
          <div>
            <h3 className="text-xl font-bold mb-1">We don&apos;t stop until you pass — or your next fix is free.</h3>
            <p className="text-blue-100 text-sm">Our AI rewrites, re-scores, and rewrites again. If we still can&apos;t get you over the verification threshold, we bank a free fix credit on your account.</p>
            <ul className="flex flex-wrap gap-x-5 gap-y-1 mt-3 text-sm font-semibold">
              <li>✓ Multiple AI attempts per fix</li><li>✓ {maxFixRetries} free manual retries</li><li>✓ Free credit if we fall short</li>
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
