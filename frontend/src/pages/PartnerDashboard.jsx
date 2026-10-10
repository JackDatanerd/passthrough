import { useState, useEffect } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import api from '../lib/api'
import { copyToClipboard, formatCents, formatRate, downloadCsv } from '../lib/utils'
import Spinner from '../components/ui/Spinner'
import StatCard from '../components/ui/StatCard'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'
import EmptyState from '../components/ui/EmptyState'
import { ATTRIBUTION_TERMS } from '../lib/partnerTerms'
import { partnerAuth } from '../lib/partnerApi'

// AUDIT FIX (bug): this local formatter put the `$` before the number's own
// negative sign — e.g. "$-5.00" — instead of "-$5.00". Harmless while every
// amount here was positive, but getPartnerDashboard's own stats.pendingCents
// can legitimately go negative (a refund/chargeback reversal outrunning a
// partner's new commission — see adminRecordPayout's comment in
// partners.controller.js), and that's shown right here as this page's
// "Pending" stat, on the one page a partner would see it. Swapped for the
// shared formatMoney/formatCents (lib/utils.js), already used correctly for
// the same negative-balance case throughout the admin side
// (PartnerDetail.jsx, AdminPartners.jsx) — one currency formatter instead of
// a second, divergent copy.
const fmtCents = formatCents

// The link itself — built client-side from window.location.origin, since
// this page is served from the same domain the link should point at. This
// is the one thing that was missing entirely before: a code alone isn't
// shareable, a URL is.
function ShareLink({ code }) {
  const [copied, setCopied] = useState(false)
  const url = `${window.location.origin}/?ref=${encodeURIComponent(code)}`

  async function copy() {
    if (await copyToClipboard(url)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div className="flex items-center gap-2 mt-2">
      <input readOnly value={url}
        onFocus={e => e.target.select()}
        className="text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-md px-2 py-1.5 flex-1 font-mono" />
      <button onClick={copy} type="button"
        className="text-sm font-medium text-blue-700 hover:underline whitespace-nowrap">
        {copied ? 'Copied ✓' : 'Copy link'}
      </button>
    </div>
  )
}

// AUDIT FIX (feature gap): the caption below used to be unconditional — a
// partner whose code had gone inactive, expired, or hit its usage limit
// still saw "gets the discount automatically" and kept promoting a dead
// link, with only a small badge above (easy to miss) telling a different
// story. Mirrors isCodeUsable's checks in referral.service.js.
//
// AUDIT FIX (Section 3/4 pass, bug): that mirror was incomplete — it never
// checked isCodeUsable's fourth condition, `partners.status !== 'ACTIVE'`,
// because getPartnerDashboard never returned the partner's own status in the
// first place. A partner whose account was PAUSED (fraud hold, a dispute,
// anything short of their code itself expiring) saw every one of their codes
// as fully live, with no way to know their links had silently stopped
// working the moment they were paused. `partnerActive` now comes from
// data.active (partners.controller.js) — see the account-level banner in the
// main component below for the other half of this fix.
const TIER_LABEL = { FIX: 'Fix + Credential', BADGE: 'Credential only', FIX_PLAIN: 'Fix only' }

// Why a code is not live (null when it is). Drives the badge so it can't
// say "Active" next to a caption saying the link isn't working.
function codeInactiveReason(code, partnerActive) {
  if (!partnerActive) return 'Paused'
  if (!code.active) return 'Inactive'
  if (code.expiresAt) {
    const expiresMs = Date.parse(code.expiresAt)
    if (Number.isNaN(expiresMs) || expiresMs < Date.now()) return 'Expired'
  }
  if (code.usageLimit != null && (code.usesSoFar || 0) >= code.usageLimit) return 'Limit reached'
  return null
}

function isCodeLive(code, partnerActive) {
  if (!partnerActive) return false
  if (!code.active) return false
  // AUDIT FIX (bug): this is meant to mirror referral.service.js's
  // isCodeUsable() so a partner never sees "live" for a code the backend
  // has actually stopped honoring. `new Date(code.expiresAt) < new Date()`
  // silently fails OPEN on an unparseable date — Invalid Date compared with
  // < is always false, the same trap isCodeUsable() was already patched
  // for on the backend. Use Date.parse + Number.isNaN so a corrupt
  // expiresAt reads as expired here too, not as "never expires."
  if (code.expiresAt) {
    const expiresMs = Date.parse(code.expiresAt)
    if (Number.isNaN(expiresMs) || expiresMs < Date.now()) return false
  }
  if (code.usageLimit != null && (code.usesSoFar || 0) >= code.usageLimit) return false
  return true
}

function CodeCard({ code, partnerActive, currency }) {
  const prices = Object.entries(code.tierPrices || {})
  const live = isCodeLive(code, partnerActive)
  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-white">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="font-mono text-lg font-bold text-blue-700">{code.code}</div>
        <span className={`text-xs px-2 py-0.5 rounded-full ${
          live ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
          {live ? 'Active' : codeInactiveReason(code, partnerActive)}
        </span>
      </div>
      <ShareLink code={code.code} />
      <div className="text-sm text-gray-500 mt-3">
        {/* AUDIT FIX (bug): this hardcoded '$' instead of using fmtCents like
            every other amount on this page (and the rest of the app) —
            exactly the currency-drift bug already fixed elsewhere for the
            checkout price tags. If PAYSTACK_CURRENCY is ever not USD, a
            partner would see the wrong symbol on their own promo prices. */}
        {prices.map(([tier, cents]) => `${TIER_LABEL[tier] || tier}: ${fmtCents(cents, currency)}`).join(' · ')}
      </div>
      <div className="text-sm text-gray-500 mt-1">
        {code.clicks || 0} clicks · {code.usesSoFar || 0} redemption{code.usesSoFar === 1 ? '' : 's'}
        {code.usageLimit ? ` (limit ${code.usageLimit})` : ''}
        {code.stats?.conversionRate != null && ` · ${formatRate(code.stats.conversionRate)} of clicks bought`}
      </div>
      <p className="text-xs text-gray-400 mt-2">
        {live ? (
          <>Anyone who visits your link gets the discount automatically. They can also just tell
          people the code <span className="font-mono">{code.code}</span> directly — there's a
          "have a code?" box at checkout too.</>
        ) : !partnerActive ? (
          <>Your partner account is currently paused, so this link is not applying the discount or
          earning commission right now — contact us if you weren't expecting that.</>
        ) : (
          <>This code isn't live anymore — links using it will fall back to standard pricing and
          won't earn you commission. Ask us about setting up a new one.</>
        )}
      </p>
    </div>
  )
}

// AUDIT FIX (Section 3/4 re-audit, feature gap): getPartnerDashboard has
// always fetched and returned the full per-conversion ledger (see
// partners.controller.js) — used to build the stats/cyclesSummary above —
// but nothing on this page ever rendered the individual rows. A partner
// could see totals ("3 conversions, $58.00 pending") but had no way to see
// WHICH referrals converted, for how much, or whether a given one had since
// been refunded — despite the admin side having exactly this view
// (PartnerDetail.jsx's Conversions tab) for the same underlying data.
function ConversionRow({ conversion, currency }) {
  const isRefund = conversion.commissionAmountCents < 0 || conversion.isReversal
  // AUDIT FIX (Section 3/4 re-audit, feature gap): getPartnerDashboard has
  // always computed and returned grossAmountCents + commissionRate per
  // conversion (see partners.controller.js) — specifically so a partner
  // isn't just told what they earned, but can see what it was earned ON and
  // at what rate. Neither was ever rendered here; a partner could only see
  // the commission amount with no way to verify it against the sale it came
  // from. Shown only for a real (non-reversal) row — a reversal's own
  // "gross" is the negative of the original sale, which is confusing framed
  // as a "sale" line rather than the refund it is.
  const showSaleLine = !conversion.isReversal && !conversion.isAdjustment && conversion.grossAmountCents != null
  return (
    <li className="text-sm text-gray-700 bg-white border border-gray-200 rounded-md px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
      <div>
        <div>
          {new Date(conversion.createdAt).toLocaleDateString()}
          {conversion.code && <> · <span className="font-mono text-xs">{conversion.code}</span></>}
          {conversion.isAdjustment && <> · <span className="text-xs font-medium text-gray-600">Balance adjustment</span></>}
        </div>
        {/* Round 8: a manual admin entry (clawback / write-off / bonus) always carries the reason the admin gave. */}
        {conversion.isAdjustment && conversion.adjustmentReason && (
          <div className="text-xs text-gray-500 mt-0.5">{conversion.adjustmentReason}</div>
        )}
        {showSaleLine && (
          <div className="text-xs text-gray-400 mt-0.5">
            {fmtCents(conversion.grossAmountCents, currency)} sale
            {conversion.commissionRate != null ? ` · ${formatRate(conversion.commissionRate)} rate` : ''}
          </div>
        )}
        {conversion.isReversal && (
          <div className="text-xs text-red-600 mt-0.5">
            Refunded{conversion.reversalReason ? ` — ${conversion.reversalReason}` : ''}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className={`font-medium ${isRefund ? 'text-red-600' : 'text-gray-900'}`}>
          {fmtCents(conversion.commissionAmountCents, currency)}
        </span>
        <span className={`text-xs px-2 py-0.5 rounded-full ${
          conversion.paid ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
          {conversion.paid ? 'Paid' : 'Unpaid'}
        </span>
      </div>
    </li>
  )
}

// AUDIT FIX (Section 3/4 pass, feature gap): getPartnerDashboard has always
// computed and returned cyclesSummary (last 3 twice-monthly cycles: current
// + 2 prior) — per its own comment, specifically "so a partner can see
// 'here's what's still accruing' vs. 'here's what's queued for the next
// payout run'" — but nothing on this page ever rendered it. A partner could
// only ever see one lump "Pending" stat, with no way to tell how much of it
// is from the still-accruing current cycle (not payable yet) vs. an older,
// already-closed cycle sitting ready for the next payout run — despite the
// admin side (PartnerDetail.jsx's CyclesTab) already showing exactly this
// breakdown from the same underlying data. Read-only here (no payout
// actions — those stay admin-only), mirroring CyclesTab's per-cycle shape.
function CycleRow({ cycle, currency }) {
  return (
    <div className="border border-gray-200 rounded-lg bg-white px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
      <div>
        <div className="font-medium text-gray-900 flex items-center gap-2">
          {cycle.label}
          {cycle.isCurrent && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
              Current — still accruing
            </span>
          )}
        </div>
        <div className="text-xs text-gray-400 mt-0.5">
          {cycle.ledgerCount} conversion{cycle.ledgerCount === 1 ? '' : 's'} · {fmtCents(cycle.commissionCents, currency)} earned
          {cycle.paidCents > 0 && ` · ${fmtCents(cycle.paidCents, currency)} already paid`}
        </div>
      </div>
      <div className="text-sm text-right shrink-0">
        {cycle.unpaidCents > 0 ? (
          cycle.isCurrent ? (
            <span className="text-gray-400">{fmtCents(cycle.unpaidCents, currency)} — not payable yet</span>
          ) : cycle.heldCents > 0 ? (
            <span className="text-gray-500">
              {cycle.unpaidCents - cycle.heldCents > 0 && (
                <span className="font-semibold text-amber-600">{fmtCents(cycle.unpaidCents - cycle.heldCents, currency)} — ready to pay · </span>
              )}
              {fmtCents(cycle.heldCents, currency)} — held (refund window or an open dispute)
            </span>
          ) : (
            <span className="font-semibold text-amber-600">{fmtCents(cycle.unpaidCents, currency)} — ready to pay</span>
          )
        ) : cycle.unpaidCents < 0 ? (
          <span className="text-red-600">{fmtCents(cycle.unpaidCents, currency)} — refund credit, nets against future commission</span>
        ) : (
          <span className="text-gray-400 italic">{cycle.ledgerCount > 0 ? 'Settled' : 'Nothing owed'}</span>
        )}
      </div>
    </div>
  )
}

// SECTION 4 ROUND 4: this page's link is READ-ONLY (it is what every earnings email carries),
// so it can no longer open the payout-details form. A holder of the older, write-capable link
// (data.scope === 'payout') still gets the direct link; everyone else asks for the real
// payout-details link to be emailed to the address on file — a forwarded or leaked
// notification email can read earnings but can't redirect where payouts go.
// Section 4 round 6 (feature gap): the dashboard carried only the 50 most recent conversions and said "showing 50 of
// N" with no way to see the rest or keep a record. "Load more" pages through GET /partners/conversions (newest first);
// "Download CSV" walks every page and writes one row per conversion or refund reversal.
const CSV_PAGE = 200
const CSV_MAX_PAGES = 25   // 5,000 rows; the endpoint is rate limited (30 reads per 5 minutes)

function ConversionsSection({ token, initial, total, currency }) {
  const [extra, setExtra] = useState([])
  const [loadingMore, setLoadingMore] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')

  const seen = new Set(initial.map(c => c.id))
  const loaded = [...initial, ...extra.filter(c => !seen.has(c.id))]
  const known = typeof total === 'number' ? total : loaded.length
  const more = known > loaded.length

  async function fetchPage(offset, limit) {
    const res = await api.get(`/partners/conversions?limit=${limit}&offset=${offset}`, partnerAuth(token))
    return res.data
  }

  async function loadMore() {
    setLoadingMore(true); setError('')
    try {
      const page = await fetchPage(loaded.length, 50)
      setExtra(prev => [...prev, ...(page.data || [])])
    } catch (_) {
      setError('Could not load more — please try again.')
    } finally { setLoadingMore(false) }
  }

  async function exportCsv() {
    setExporting(true); setError('')
    try {
      const rows = []
      for (let page = 0; page < CSV_MAX_PAGES; page++) {
        const out = await fetchPage(page * CSV_PAGE, CSV_PAGE)
        rows.push(...(out.data || []))
        if ((out.data || []).length < CSV_PAGE) break
      }
      const unique = [...new Map(rows.map(r => [r.id, r])).values()]
      downloadCsv(`passthrough-conversions-${new Date().toISOString().slice(0, 10)}.csv`, [
        ['Date (UTC)', 'Code', 'Type', 'Sale', 'Commission rate', 'Commission', 'Status', 'Note', 'Currency'],
        ...unique.map(r => [
          String(r.createdAt || '').slice(0, 10), r.code || '',
          r.isAdjustment ? 'Adjustment' : r.isReversal ? 'Refund reversal' : 'Sale',
          (r.grossAmountCents || 0) / 100,
          r.commissionRate == null ? '' : `${+(r.commissionRate * 100).toFixed(2)}%`,
          (r.commissionAmountCents || 0) / 100,
          r.isReversal ? 'Reversal' : r.paid ? 'Paid' : 'Pending',
          r.isAdjustment ? (r.adjustmentReason || '') : '',
          currency || '',
        ]),
      ])
    } catch (_) {
      setError('Could not build the CSV — please try again in a moment.')
    } finally { setExporting(false) }
  }

  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-gray-900">Conversions</h2>
        {loaded.length > 0 && (
          <button type="button" onClick={exportCsv} disabled={exporting}
            className="text-sm text-blue-600 hover:underline disabled:opacity-50 disabled:no-underline">
            {exporting ? 'Preparing…' : 'Download CSV'}
          </button>
        )}
      </div>
      {loaded.length === 0 ? (
        <p className="text-sm text-gray-500 mb-8">
          No conversions yet — once someone buys through your link, it'll show up here.
        </p>
      ) : (
        <div className="mb-8">
          <ul className="flex flex-col gap-2 mb-2">
            {loaded.map(cv => <ConversionRow key={cv.id} conversion={cv} currency={currency} />)}
          </ul>
          <div className="flex items-center gap-3">
            {typeof total === 'number' && total > loaded.length && (
              <p className="text-xs text-gray-400">Showing {loaded.length} of {total} entries (sales, refunds and adjustments).</p>
            )}
            {more && (
              <button type="button" onClick={loadMore} disabled={loadingMore}
                className="text-sm text-blue-600 hover:underline disabled:opacity-50 disabled:no-underline">
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            )}
          </div>
          {error && <p role="alert" className="text-xs text-red-600 mt-1">{error}</p>}
        </div>
      )}
    </>
  )
}

function PayoutDetailsAccess({ token, scope, children, className }) {
  const [state, setState] = useState('idle')   // idle | sending | sent | error
  if (scope === 'payout') {
    return (
      <Link to={`/partner/payout-details?token=${encodeURIComponent(token)}`} className={className}>
        {children}
      </Link>
    )
  }
  async function request() {
    setState('sending')
    try {
      await api.post('/partners/request-payout-link', null, partnerAuth(token))
      setState('sent')
    } catch (_) { setState('error') }
  }
  if (state === 'sent') return <span className="text-sm text-green-700">Sent — check the inbox of the email address we have on file.</span>
  return (
    <span>
      <button type="button" onClick={request} disabled={state === 'sending'} className={className}>
        {state === 'sending' ? 'Sending…' : children}
      </button>
      {state === 'error' && <span className="text-xs text-red-600 ml-2">Couldn't send — try again in a few minutes.</span>}
    </span>
  )
}

// Round 5: one email per sale is the default; a busy partner can switch those off. Reversal,
// payout and account emails are never suppressed by this.
function NotificationPrefs({ token, initial }) {
  const [on, setOn] = useState(initial !== false)
  const [state, setState] = useState('idle')   // idle | saving | error
  async function toggle() {
    const next = !on
    setState('saving')
    try {
      await api.post('/partners/notifications', { conversions: next }, partnerAuth(token))
      setOn(next); setState('idle')
    } catch (_) { setState('error') }
  }
  return (
    <div className="mt-8 bg-white border border-gray-200 rounded-md px-4 py-3 flex items-center justify-between gap-3 flex-wrap" data-testid="notification-prefs">
      <div>
        <p className="text-sm font-medium text-gray-900">Email me for each sale</p>
        <p className="text-xs text-gray-500">
          {on ? 'You get an email whenever a sale earns you a commission.' : 'Off — you can still see every sale here. Refund, payout and account emails still reach you.'}
        </p>
        {state === 'error' && <p className="text-xs text-red-600 mt-1">Couldn't save that — try again in a moment.</p>}
      </div>
      <button type="button" role="switch" aria-checked={on} onClick={toggle} disabled={state === 'saving'}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${on ? 'bg-blue-600' : 'bg-gray-300'} disabled:opacity-60`}>
        <span className="sr-only">Email me for each sale</span>
        <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${on ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </button>
    </div>
  )
}

// Round 8: terms acceptance. An admin-created partner never recorded one and a version bump had no path at all.
// Not a gate on anything - recorded, and prompted until done.
function TermsPrompt({ token, version, onAccepted }) {
  const [state, setState] = useState('idle')   // idle | saving | error
  async function accept() {
    setState('saving')
    try { await api.post('/partners/accept-terms', {}, partnerAuth(token)); onAccepted() } catch (_) { setState('error') }
  }
  return (
    <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900" data-testid="terms-prompt">
      <p>
        Please review the current <Link to="/partner/terms" className="underline font-medium">Partner Program terms</Link>
        {version ? ` (version ${version})` : ''} and accept them. Your links keep working in the meantime.
      </p>
      <button type="button" onClick={accept} disabled={state === 'saving'}
        className="mt-2 px-3 py-1.5 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-60">
        {state === 'saving' ? 'Saving…' : 'I accept the current terms'}
      </button>
      {state === 'error' && <p className="text-xs text-red-600 mt-1">Couldn't save that — try again in a moment.</p>}
    </div>
  )
}

function payoutAccountLabel(a) {
  if (!a) return ''
  const kind = a.method === 'BANK' ? 'Bank transfer' : 'Mobile money'
  return `${kind}${a.provider ? ` · ${a.provider}` : ''}${a.last4 ? ` · ending ${a.last4}` : ''}`
}

export default function PartnerDashboard() {
  const [params] = useSearchParams()
  const token = params.get('token')

  const [loading, setLoading] = useState(true)
  const [invalid, setInvalid] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [data, setData] = useState(null)
  const [termsDone, setTermsDone] = useState(false)

  useEffect(() => {
    if (!token) { setInvalid(true); setLoading(false); return }
    api.get('/partners/dashboard', partnerAuth(token))
      .then(res => setData(res.data.data))
      .catch(err => {
        // Only a genuinely bad/expired link says so; a 429/500/network drop is
        // transient and must not send the partner off to request a new link.
        const status = err?.response?.status
        if (status === 404 || status === 400) setInvalid(true)
        else setLoadError(true)
      })
      .finally(() => setLoading(false))
  }, [token])

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <Navbar />
      <main className="flex-1 max-w-3xl mx-auto w-full px-4 py-10">
        {loading ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : loadError ? (
          <div className="bg-white rounded-lg border border-gray-200 p-8">
            <h1 className="text-xl font-bold text-gray-900 mb-2">Couldn't load your dashboard</h1>
            <p className="text-sm text-gray-600">
              Something went wrong on our side or with your connection — your link is fine.
              Please refresh in a moment.
            </p>
          </div>
        ) : invalid ? (
          <div className="bg-white rounded-lg border border-gray-200 p-8">
            <h1 className="text-xl font-bold text-gray-900 mb-2">Link not valid</h1>
            <p className="text-sm text-gray-600">
              This dashboard link is invalid or has expired.{' '}
              <Link to="/partner/recover" className="text-blue-600 hover:underline">Email me a new one</Link>.
            </p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
              <h1 className="text-2xl font-bold text-gray-900">
                {data.name}'s Passthrough dashboard
              </h1>
              <PayoutDetailsAccess token={token} scope={data.scope} className="text-sm text-blue-600 hover:underline">
                {data.scope === 'payout' ? 'Update payout details →' : 'Email me a payout-details link →'}
              </PayoutDetailsAccess>
            </div>
            {/* AUDIT FIX (Section 3/4 re-audit, feature gap): getPartnerDashboard
                has always returned commissionRate — the rate applied to every
                sale below — but this page never displayed it anywhere. A
                partner had no way to know their own rate except by manually
                back-computing it from a commission amount against a sale price
                they'd have to already know. */}
            {data.commissionRate != null && (
              <p className="text-sm text-gray-500 mb-5">
                You earn {formatRate(data.commissionRate)} commission on every sale through your link.
              </p>
            )}
            {/* Payments & Pricing round 4, G6: the same crediting terms an applicant sees. */}
            <details className="text-sm text-gray-500 mb-5" data-testid="attribution-terms">
              <summary className="cursor-pointer text-gray-600 hover:text-gray-800">How crediting works</summary>
              <ul className="list-disc pl-5 mt-2 space-y-1">
                {ATTRIBUTION_TERMS.map(t => <li key={t}>{t}</li>)}
              </ul>
            </details>

            {/* AUDIT FIX (Section 3/4 pass, bug): see isCodeLive's comment —
                this is the account-level half of that fix. Without it, a
                paused partner had no indication anywhere on their own
                dashboard that their links had stopped working. */}
            {!data.active && (
              <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                Your partner account is currently paused. Your links won't apply discounts or earn
                commission until it's reactivated — contact us if you weren't expecting that.
              </div>
            )}

            {/* Money is owed (or accruing) but we have nowhere to send it. */}
            {!data.hasPayoutDetails && (data.stats.pendingCents > 0 || data.stats.paidCents > 0) && (
              <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
                We don't have your payout details yet, so we can't pay you.{' '}
                <PayoutDetailsAccess token={token} scope={data.scope} className="underline font-medium">
                  {data.scope === 'payout' ? 'Add them now →' : 'Email me a link to add them →'}
                </PayoutDetailsAccess>
              </div>
            )}
            {/* Round 8: where payouts go (last four only) and, right after a change, that payouts are paused for a while. */}
            {data.hasPayoutDetails && data.payoutAccount && (
              <p className="text-sm text-gray-500 mb-5" data-testid="payout-account">
                Payouts go to: <span className="font-medium text-gray-700">{payoutAccountLabel(data.payoutAccount)}</span>
              </p>
            )}
            {data.payoutHoldUntil && (
              <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" data-testid="payout-hold">
                You changed your payout details recently, so the next payout is on hold until about{' '}
                {new Date(data.payoutHoldUntil).toLocaleString()}. This protects you if someone else ever got hold of your link.
              </div>
            )}
            {data.termsAcceptanceRequired && !termsDone && (
              <TermsPrompt token={token} version={data.currentTermsVersion} onAccepted={() => setTermsDone(true)} />
            )}
            {data.belowMinimum && (
              <div className="mb-6 rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-600">
                Payouts start at {fmtCents(data.minPayoutCents, data.currency)}. Your {fmtCents(data.carriedForwardCents, data.currency)} carries
                forward and will be paid once your balance reaches it.
              </div>
            )}

            {/* Round 6: the figures the admin side has always had. What the next payout run will actually pay, and any
                refund credit that will net against it, instead of making the partner add up the cycle rows below. */}
            {data.readyToPayCents > 0 && (
              <div className="mb-6 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900" data-testid="ready-to-pay">
                <span className="font-semibold">{fmtCents(data.readyToPayCents, data.currency)}</span> is ready to be paid in the next payout run.
              </div>
            )}
            {data.creditCents > 0 && (
              <div className="mb-6 rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-600" data-testid="refund-credit">
                A credit of {fmtCents(data.creditCents, data.currency)} (refunds or balance adjustments) will be taken off your next payout.
              </div>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
              <StatCard label="Clicks" value={data.stats.totalClicks} />
              <StatCard label="Conversions" value={data.stats.totalConversions} />
              <StatCard label="Pending" value={fmtCents(data.stats.pendingCents, data.currency)} />
              <StatCard label="Paid to date" value={fmtCents(data.stats.paidCents, data.currency)} />
            </div>

            {data.cyclesSummary?.length > 0 && (
              <>
                <h2 className="text-lg font-semibold text-gray-900 mb-3">Payout cycles</h2>
                <div className="flex flex-col gap-2 mb-8">
                  {data.cyclesSummary.map(cycle => (
                    <CycleRow key={cycle.key} cycle={cycle} currency={data.currency} />
                  ))}
                  {data.olderUnpaidCents !== 0 && (
                    <div className="border border-gray-200 rounded-lg bg-white px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
                      <div className="font-medium text-gray-900">Earlier cycles</div>
                      <div className={`text-sm ${data.olderUnpaidCents > 0 ? 'font-semibold text-amber-600' : 'text-red-600'}`}>
                        {fmtCents(data.olderUnpaidCents, data.currency)} {data.olderUnpaidCents > 0 ? '— still unpaid' : '— refund credit, nets against future commission'}
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}

            <h2 className="text-lg font-semibold text-gray-900 mb-3">Your codes</h2>
            {data.referralCodes.length === 0 ? (
              <p className="text-sm text-gray-500 mb-8">
                No referral code yet — we'll email you as soon as one is set up.
              </p>
            ) : (
              <div className="flex flex-col gap-3 mb-8">
                {data.referralCodes.map(code => (
                  <CodeCard key={code.id} code={code} partnerActive={data.active} currency={data.currency} />
                ))}
              </div>
            )}

            <ConversionsSection token={token} initial={data.conversions || []} total={data.conversionsTotal} currency={data.currency} />

            <h2 className="text-lg font-semibold text-gray-900 mb-3">Payout history</h2>
            {data.payouts.length === 0 ? (
              <EmptyState>No payouts yet.</EmptyState>
            ) : (
              <ul className="flex flex-col gap-2">
                {data.payouts.map(p => (
                  <li key={p.id} className="text-sm text-gray-700 bg-white border border-gray-200 rounded-md px-4 py-3 flex justify-between">
                    <span>{new Date(p.paidAt).toLocaleDateString()}{p.note ? ` — ${p.note}` : ''}</span>
                    <span className="font-medium">{fmtCents(p.amountCents, p.currency)}</span>
                  </li>
                ))}
              </ul>
            )}

            <NotificationPrefs token={token} initial={data.notifyConversions} />
          </>
        )}
      </main>
      <Footer />
    </div>
  )
}
