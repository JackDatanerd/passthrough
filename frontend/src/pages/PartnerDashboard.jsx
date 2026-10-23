import { useState, useEffect } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import api from '../lib/api'
import { formatCents, formatRate, downloadCsv, formatDateUtc, formatDateTime, formatNumber, dateStamp } from '../lib/utils'
import CopyButton from '../components/ui/CopyButton'
import Spinner from '../components/ui/Spinner'
import StatCard from '../components/ui/StatCard'
import Switch from '../components/ui/Switch'
import Input from '../components/ui/Input'
import Select from '../components/ui/Select'
import Disclosure from '../components/ui/Disclosure'
import PartnerLayout from '../components/partner/PartnerLayout'
import EmptyState from '../components/ui/EmptyState'
import { ATTRIBUTION_TERMS, ATTRIBUTION_WINDOW_DAYS } from '../lib/partnerTerms'
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
// Round 11 (gap): the share link only ever pointed at the home page. useReferralCapture runs on every route, so a link to
// the pricing page captures the code the same way and lands the visitor closer to a purchase.
const SHARE_PAGES = [['', 'Home page'], ['pricing', 'Pricing page']]
// Round 16 (gap): an optional channel tag (`&sub=newsletter`) so a partner who shares one code in several places can see which
// placement earned each sale (Sales by channel below). Same rule as the server: 1-32 of a-z 0-9 _ -, shown lower-case.
const SUB_TAG_RE = /^[a-z0-9_-]{1,32}$/
// Round 19: the ledger stores a reason CODE (REFUND / DISPUTE / ADMIN_REVERSED). It used to be printed as-is after "Refunded —",
// so partners read "Refunded — ADMIN_REVERSED", and a sale an admin rejected was called a refund although the buyer was not refunded.
const REVERSAL_LABELS = {
  REFUND: 'Refunded',
  DISPUTE: 'Reversed — the payment was disputed',
  ADMIN_REVERSED: 'Reversed by Passthrough',
}
function reversalLabel(reason) { return REVERSAL_LABELS[reason] || 'Reversed' }

function ShareLink({ code }) {
  const [page, setPage] = useState('')
  const [tag, setTag] = useState('')
  const cleanTag = tag.trim().toLowerCase()
  const tagOk = SUB_TAG_RE.test(cleanTag)
  const url = `${window.location.origin}/${page}?ref=${encodeURIComponent(code)}${tagOk ? `&sub=${encodeURIComponent(cleanTag)}` : ''}`

  return (
    <div className="flex items-center gap-2 mt-2 flex-wrap">
      {/* The shared fields: their text is 16px on a phone (a 14px field makes iOS zoom the page in on focus - partners open this on
          their phones), and the link field now has a name (it had none). */}
      <Select size="sm" value={page} onChange={e => setPage(e.target.value)} aria-label="Page the link opens">
        {SHARE_PAGES.map(([value, label]) => <option key={value || 'home'} value={value}>{label}</option>)}
      </Select>
      <Input size="sm" readOnly value={url} aria-label="Your referral link" wrapperClassName="flex-1 min-w-[12rem]" className="font-mono"
        onFocus={e => e.target.select()} />
      <CopyButton variant="link" text={url} label="Copy link" copiedLabel="Copied ✓"
        className="text-sm font-medium text-blue-700 hover:underline whitespace-nowrap" />
      <div className="basis-full flex items-center gap-2 flex-wrap">
        <Input size="sm" value={tag} onChange={e => setTag(e.target.value)} maxLength={40} placeholder="Channel tag (optional), e.g. newsletter"
          aria-label="Channel tag for this link" data-testid="share-sub-input" wrapperClassName="w-64 max-w-full" />
        <span className={`text-xs ${cleanTag && !tagOk ? 'text-amber-700' : 'text-gray-400'}`} data-testid="share-sub-hint">
          {cleanTag && !tagOk
            ? 'Use 1–32 letters, digits, - or _ — the tag is left off the link until it fits.'
            : 'Tag a link per placement to see which one earns sales.'}
        </span>
      </div>
    </div>
  )
}

// Round 11 (gap): direction at a glance - net commission per cycle for the last six cycles, and how buyers reached the code.
const MIX_LABELS = { link: 'Shared link', typed: 'Typed the code', account: 'Remembered on their account', unknown: 'Earlier sales (not recorded)' }
function TrendSection({ trend, mix, subMix, currency }) {
  const rows = Array.isArray(trend) ? trend : []
  const hasData = rows.some(r => r.commissionCents !== 0 || r.sales > 0)
  const max = Math.max(1, ...rows.map(r => Math.abs(r.commissionCents)))
  const mixTotal = mix ? Object.values(mix).reduce((a, b) => a + b, 0) : 0
  const subs = Array.isArray(subMix) ? subMix : []
  if (!hasData && mixTotal === 0 && subs.length === 0) return null
  return (
    <section data-testid="partner-trend">
      <h2 className="text-lg font-semibold text-gray-900 mb-3">Earnings by cycle</h2>
      {hasData && (
        <div className="border border-gray-200 rounded-xl bg-white p-4 sm:p-5">
          {/* One column per cycle, oldest to newest: the taller the column, the more commission that cycle earned.
              A cycle that ended up negative (refunds outran sales) is red. The current cycle is darker. */}
          <ol aria-label="Earnings by cycle" className="flex items-end gap-2 sm:gap-4 h-44">
            {rows.map(r => {
              const height = Math.max(r.commissionCents !== 0 ? 4 : 0, Math.round(Math.abs(r.commissionCents) / max * 100))
              return (
                <li key={r.key} className="flex-1 min-w-0 h-full flex flex-col justify-end items-center gap-1 text-center">
                  <span className="text-xs sm:text-sm font-semibold text-gray-900 truncate max-w-full">{fmtCents(r.commissionCents, currency)}</span>
                  <div aria-hidden="true" className={`w-full max-w-[3.5rem] rounded-t-md ${r.commissionCents < 0 ? 'bg-red-400' : r.isCurrent ? 'bg-blue-700' : 'bg-blue-400'}`}
                    style={{ height: `${height}%`, minHeight: height ? 4 : 0 }} />
                </li>
              )
            })}
          </ol>
          <ul className="flex gap-2 sm:gap-4 mt-2 border-t border-gray-100 pt-2" aria-label="Cycle details">
            {rows.map(r => (
              <li key={r.key} className="flex-1 min-w-0 text-center text-xs text-gray-500">
                <span className="block truncate text-gray-700">{r.label}{r.isCurrent ? ' (so far)' : ''}</span>
                <span className="block">{r.sales} sale{r.sales === 1 ? '' : 's'}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-gray-400 mt-3">Net of refunds and adjustments, by the day each commission was recorded.</p>
        </div>
      )}
      {mixTotal > 0 && (
        <div className="mt-3 text-sm text-gray-600" data-testid="partner-attribution-mix">
          <span className="font-medium text-gray-900">How buyers reached your code: </span>
          {Object.entries(mix).filter(([, n]) => n > 0).map(([k, n]) => `${MIX_LABELS[k]} ${n}`).join(' · ')}
        </div>
      )}
      {subs.length > 0 && (
        <div className="mt-3 text-sm text-gray-600" data-testid="partner-sub-mix">
          <span className="font-medium text-gray-900">Sales by channel tag: </span>
          {subs.map(r => {
            // Round 18: visits per tag next to its sales, so a channel that sends traffic but never sells is visible.
            const visits = r.clicks > 0 ? `${formatNumber(r.clicks)} visit${r.clicks === 1 ? '' : 's'} → ` : ''
            const rate = r.clicks > 0 && r.sales > 0 ? `, ${+(Math.min(100, r.sales / r.clicks * 100)).toFixed(1)}%` : ''
            return `${r.sub} ${visits}${r.sales} sale${r.sales === 1 ? '' : 's'} (${fmtCents(r.commissionCents, currency)}${rate})`
          }).join(' · ')}
        </div>
      )}
    </section>
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
function codeInactiveReason(code, partnerActive, status) {
  if (!partnerActive) return status === 'ENDED' ? 'Ended' : 'Paused'
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

function CodeCard({ code, partnerActive, partnerStatus, currency }) {
  const prices = Object.entries(code.tierPrices || {})
  const live = isCodeLive(code, partnerActive)
  return (
    <div className="border border-gray-200 rounded-xl p-4 bg-white">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="font-mono text-lg font-bold text-blue-700">{code.code}</div>
        <span className={`text-xs px-2 py-0.5 rounded-full ${
          live ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
          {live ? 'Active' : codeInactiveReason(code, partnerActive, partnerStatus)}
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
        {prices.length < Object.keys(TIER_LABEL).length && (
          <span className="block text-xs text-gray-400 mt-0.5">
            Other plans are bought at their normal price with this code — you still earn commission on them.
          </span>
        )}
      </div>
      <div className="text-sm text-gray-500 mt-1">
        {code.clicks || 0} clicks{code.signups != null ? ` · ${code.signups} sign-up${code.signups === 1 ? '' : 's'} (last ${ATTRIBUTION_WINDOW_DAYS} days)` : ''} · {code.usesSoFar || 0} redemption{code.usesSoFar === 1 ? '' : 's'}
        {code.usageLimit ? ` (limit ${code.usageLimit})` : ''}
        {code.stats?.conversionRate != null && ` · ${formatRate(code.stats.conversionRate)} of clicks bought`}
        {/* Round 27: what this one code has earned (net of refunds), so a partner with several codes can see which ones pay. */}
        {code.stats?.commissionCents != null && (code.stats.conversions > 0 || code.stats.commissionCents !== 0) && (
          <span data-testid="code-earned">{` · earned ${fmtCents(code.stats.commissionCents, currency)}`}</span>
        )}
      </div>
      <p className="text-xs text-gray-400 mt-2">
        {live ? (
          <>Anyone who visits your link gets the discount automatically. They can also just tell
          people the code <span className="font-mono">{code.code}</span> directly — there's a
          "have a code?" box at checkout too.</>
        ) : !partnerActive ? (
          partnerStatus === 'ENDED'
            ? <>Your partner membership has ended, so this link no longer applies a discount or earns commission.
            Commission you earned before then is still paid.</>
            : <>Your partner account is currently paused, so this link is not applying the discount or
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
          {formatDateUtc(conversion.createdAt)}
          {conversion.code && <> · <span className="font-mono text-xs">{conversion.code}</span></>}
          {conversion.sub && <> · <span className="text-xs text-gray-500" data-testid="conversion-sub">#{conversion.sub}</span></>}
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
            {reversalLabel(conversion.reversalReason)}
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
// Round 20: say WHEN held money frees up. An age hold ends holdDays after the last held sale; an open dispute has no date.
function heldText(cycle, currency) {
  const dispute = cycle.heldDisputeCents || 0
  const parts = []
  if (cycle.heldUntil) parts.push(`${fmtCents(cycle.heldCents - dispute, currency)} — held until ${formatDateUtc(cycle.heldUntil)} (refund window)`)
  if (dispute !== 0) parts.push(`${fmtCents(dispute, currency)} — held until a payment dispute is resolved`)
  return parts.length ? parts.join(' · ') : `${fmtCents(cycle.heldCents, currency)} — held (refund window or an open dispute)`
}

function CycleRow({ cycle, currency }) {
  return (
    <div className="border border-gray-200 rounded-xl bg-white px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
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
              {heldText(cycle, currency)}
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
const CSV_MAX_PAGES = 25   // 5,000 rows; the export has its own rate-limit bucket (90 reads per 5 minutes)

function ConversionsSection({ token, initial, total, currency, payouts = [] }) {
  const [extra, setExtra] = useState([])
  const [loadingMore, setLoadingMore] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const seen = new Set(initial.map(c => c.id))
  const loaded = [...initial, ...extra.filter(c => !seen.has(c.id))]
  const known = typeof total === 'number' ? total : loaded.length
  const more = known > loaded.length

  // `export=1` puts the CSV walk in its own rate-limit bucket (round 10) so a long export cannot lock the dashboard out.
  async function fetchPage(offset, limit, exportMode = false) {
    const res = await api.get(`/partners/conversions?limit=${limit}&offset=${offset}${exportMode ? '&export=1' : ''}`, partnerAuth(token))
    return res.data
  }
  const paidOnById = new Map(payouts.map(p => [p.id, p.paidAt]))

  async function loadMore() {
    setLoadingMore(true); setError('')
    try {
      const page = await fetchPage(initial.length + extra.length, 50)   // round 29: the raw count, not the de-duplicated one, or an all-duplicate page stalls
      setExtra(prev => [...prev, ...(page.data || [])])
    } catch (_) {
      setError('Could not load more — please try again.')
    } finally { setLoadingMore(false) }
  }

  async function exportCsv() {
    setExporting(true); setError(''); setNotice('')
    try {
      const rows = []
      let complete = false
      for (let page = 0; page < CSV_MAX_PAGES; page++) {
        const out = await fetchPage(page * CSV_PAGE, CSV_PAGE, true)
        rows.push(...(out.data || []))
        if ((out.data || []).length < CSV_PAGE) { complete = true; break }
      }
      // Round 15 (gap): hitting the page cap used to stop silently, so a long history produced a CSV that looked complete.
      if (!complete) setNotice(`The CSV holds your ${formatNumber(rows.length)} most recent entries — older ones are not included.`)
      const unique = [...new Map(rows.map(r => [r.id, r])).values()]
      downloadCsv(`passthrough-conversions-${dateStamp()}.csv`, [
        ['Date (UTC)', 'Code', 'Type', 'Sale', 'Commission rate', 'Commission', 'Status', 'Paid on (UTC)', 'Note', 'Currency', 'Channel tag'],
        ...unique.map(r => [
          String(r.createdAt || '').slice(0, 10), r.code || '',
          r.isAdjustment ? 'Adjustment' : r.isReversal ? 'Refund reversal' : 'Sale',
          (r.grossAmountCents || 0) / 100,
          r.commissionRate == null ? '' : `${+(r.commissionRate * 100).toFixed(2)}%`,
          (r.commissionAmountCents || 0) / 100,
          r.isReversal ? 'Reversal' : r.paid ? 'Paid' : 'Pending',
          r.paid && paidOnById.get(r.payoutId) ? String(paidOnById.get(r.payoutId)).slice(0, 10) : '',
          r.isAdjustment ? (r.adjustmentReason || '') : '',
          currency || '',
          r.sub || '',
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
        <p className="text-sm text-gray-500">
          No conversions yet — once someone buys through your link, it'll show up here.
        </p>
      ) : (
        <div>
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
      {notice && <p role="status" className="text-xs text-amber-700 mt-1" data-testid="csv-truncated">{notice}</p>}
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

// Round 10 (feature gap): a payout showed only a date and an amount, so a partner could not reconcile what they were paid
// against the sales behind it. "Sales in this payout" lists exactly the ledger rows that payout settled (refund credits
// netted into it show as negative lines) and totals them.
function PayoutStatement({ token, payout, currency }) {
  const [state, setState] = useState('loading')   // loading | ready | error
  const [rows, setRows] = useState([])
  const [truncated, setTruncated] = useState(false)
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const all = []
        let more = false
        for (let offset = 0; offset < 2000; offset += 200) {
          const res = await api.get(`/partners/conversions?payoutId=${encodeURIComponent(payout.id)}&limit=200&offset=${offset}`, partnerAuth(token))
          const page = res.data.data || []
          all.push(...page)
          // Round 23: a full last page is only "truncated" if the server says rows remain (a payout of exactly 2,000 is complete).
          more = typeof res.data.total === 'number' ? all.length < res.data.total : page.length >= 200
          if (!more || page.length < 200) break
        }
        // The cap keeps a huge payout from hammering the read limiter. When it is hit the list is a PREFIX, so the sum of
        // it must not be presented as what the payout settled.
        if (alive) { setRows(all); setTruncated(more); setState('ready') }
      } catch (_) { if (alive) setState('error') }
    })()
    return () => { alive = false }
  }, [token, payout.id])
  const total = rows.reduce((sum, r) => sum + (r.commissionAmountCents || 0), 0)
  return (
    <div className="mt-2 bg-gray-50 border border-gray-200 rounded-md px-3 py-2" data-testid="payout-statement">
      {state === 'loading' && <p className="text-xs text-gray-500">Loading…</p>}
      {state === 'error' && <p role="alert" className="text-xs text-red-600">Could not load the sales for this payout — please try again.</p>}
      {state === 'ready' && rows.length === 0 && <p className="text-xs text-gray-500">No itemised sales are linked to this payout (it may be an ad hoc or bonus payment).</p>}
      {state === 'ready' && rows.length > 0 && (
        <>
          <ul className="flex flex-col gap-1">
            {rows.map(r => (
              <li key={r.id} className="text-xs text-gray-700 flex justify-between gap-3">
                <span>{formatDateUtc(r.createdAt)}{r.code ? ` · ${r.code}` : ''}{r.isAdjustment ? ' · adjustment' : r.isReversal ? ' · refund' : ''}</span>
                <span className={r.commissionAmountCents < 0 ? 'text-red-600' : ''}>{fmtCents(r.commissionAmountCents, currency)}</span>
              </li>
            ))}
          </ul>
          {truncated ? (
            <p className="text-xs text-gray-500 mt-2">Showing the first {formatNumber(rows.length)} sales of a larger payout, so no total is shown here — the payout amount above is the full figure.</p>
          ) : (
            <p className="text-xs font-medium text-gray-900 mt-2 flex justify-between"><span>Commission settled by this payout</span><span>{fmtCents(total, currency)}</span></p>
          )}
        </>
      )}
    </div>
  )
}

// Round 10 (feature gap): reset both links yourself. The new links are emailed to the address on file only.
function ResetLinks({ token }) {
  const [state, setState] = useState('idle')   // idle | confirm | sending | sent | error
  const [message, setMessage] = useState('')
  async function reset() {
    setState('sending'); setMessage('')
    try {
      const res = await api.post('/partners/reset-links', {}, partnerAuth(token))
      setMessage(res.data?.message || 'Done — check your email for your new links.'); setState('sent')
    } catch (err) {
      setMessage(err?.response?.data?.message || 'Could not reset your links — please try again in a few minutes.'); setState('error')
    }
  }
  return (
    <div className="bg-white border border-gray-200 rounded-xl px-4 py-3" data-testid="reset-links">
      <p className="text-sm font-medium text-gray-900">Think your link leaked?</p>
      <p className="text-xs text-gray-500 mb-2">Reset your dashboard and payout links. The old ones stop working immediately and the new ones are emailed to the address we have on file.</p>
      {state === 'sent' ? (
        <p className="text-sm text-green-700" role="status">{message} This page's link no longer works.</p>
      ) : state === 'confirm' || state === 'sending' || state === 'error' ? (
        <div className="flex items-center gap-3 flex-wrap">
          <button type="button" onClick={reset} disabled={state === 'sending'}
            className="text-sm text-red-600 hover:underline disabled:opacity-50 disabled:no-underline">
            {state === 'sending' ? 'Resetting…' : 'Yes, reset both links'}
          </button>
          <button type="button" onClick={() => setState('idle')} disabled={state === 'sending'} className="text-sm text-gray-500 hover:underline">Cancel</button>
          {state === 'error' && <span role="alert" className="text-xs text-red-600">{message}</span>}
        </div>
      ) : (
        <button type="button" onClick={() => setState('confirm')} className="text-sm text-blue-600 hover:underline">Reset my links</button>
      )}
    </div>
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
    <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 flex items-center justify-between gap-3 flex-wrap" data-testid="notification-prefs">
      <div>
        <p className="text-sm font-medium text-gray-900">Email me for each sale</p>
        <p className="text-xs text-gray-500">
          {on ? 'You get an email whenever a sale earns you a commission.' : 'Off — you can still see every sale here. Refund, payout and account emails still reach you.'}
        </p>
        {state === 'error' && <p className="text-xs text-red-600 mt-1">Couldn't save that — try again in a moment.</p>}
      </div>
      <Switch label="Email me for each sale" checked={on} onChange={toggle} disabled={state === 'saving'} />
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
    <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900" data-testid="terms-prompt">
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
  const [statementId, setStatementId] = useState(null)   // round 10: which payout's sales are expanded

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

  // The strip in the header: jumps to each part of the page.
  const sections = data ? [
    { id: 'overview', label: 'Overview' },
    { id: 'earnings', label: 'Earnings' },
    { id: 'codes', label: 'Codes' },
    { id: 'payouts', label: 'Payouts' },
    { id: 'settings', label: 'Settings' },
  ] : []

  return (
    <PartnerLayout name={data?.name} sections={sections}>
        {loading ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : loadError ? (
          <div className="max-w-xl mx-auto bg-white rounded-xl border border-gray-200 p-8">
            <h1 className="text-xl font-bold text-gray-900 mb-2">Couldn't load your dashboard</h1>
            <p className="text-sm text-gray-600">
              Something went wrong on our side or with your connection — your link is fine.
              Please refresh in a moment.
            </p>
          </div>
        ) : invalid ? (
          <div className="max-w-xl mx-auto bg-white rounded-xl border border-gray-200 p-8">
            <h1 className="text-xl font-bold text-gray-900 mb-2">Link not valid</h1>
            <p className="text-sm text-gray-600">
              This dashboard link is invalid or has expired.{' '}
              <Link to="/partner/recover" className="text-blue-600 hover:underline">Email me a new one</Link>.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-8">
            <div id="overview" className="scroll-mt-24 flex flex-col gap-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
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
                <p className="text-sm text-gray-500 -mt-2">
                  You earn {formatRate(data.commissionRate)} commission on every sale through your link.
                </p>
              )}
              {/* Payments & Pricing round 4, G6: the same crediting terms an applicant sees. */}
              <details className="text-sm text-gray-500" data-testid="attribution-terms">
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
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" data-testid={data.status === 'ENDED' ? 'account-ended' : 'account-paused'}>
                  {data.status === 'ENDED'
                    ? "Your partner membership has ended. Your links no longer apply discounts or earn commission. Commission you earned before then is still paid, less any reversals — it stays visible here."
                    : "Your partner account is currently paused. Your links won't apply discounts or earn commission until it's reactivated — contact us if you weren't expecting that."}
                </div>
              )}

              {/* Money is owed (or accruing) but we have nowhere to send it. */}
              {!data.hasPayoutDetails && (data.stats.pendingCents > 0 || data.stats.paidCents > 0) && (
                <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
                  We don't have your payout details yet, so we can't pay you.{' '}
                  <PayoutDetailsAccess token={token} scope={data.scope} className="underline font-medium">
                    {data.scope === 'payout' ? 'Add them now →' : 'Email me a link to add them →'}
                  </PayoutDetailsAccess>
                </div>
              )}
              {/* Round 8: where payouts go (last four only) and, right after a change, that payouts are paused for a while. */}
              {data.hasPayoutDetails && data.payoutAccount && (
                <p className="text-sm text-gray-500" data-testid="payout-account">
                  Payouts go to: <span className="font-medium text-gray-700">{payoutAccountLabel(data.payoutAccount)}</span>
                </p>
              )}
              {data.payoutHoldUntil && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" data-testid="payout-hold">
                  You added or changed your payout details recently, so the next payout is on hold until about{' '}
                  {formatDateTime(data.payoutHoldUntil)}. This protects you if someone else ever got hold of your link.
                </div>
              )}
              {data.termsAcceptanceRequired && !termsDone && (
                <TermsPrompt token={token} version={data.currentTermsVersion} onAccepted={() => setTermsDone(true)} />
              )}
              {data.belowMinimum && (
                <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-600">
                  Payouts start at {fmtCents(data.minPayoutCents, data.currency)}. Your {fmtCents(data.carriedForwardCents, data.currency)} carries
                  forward and will be paid once your balance reaches it.
                </div>
              )}

              {/* Round 6: the figures the admin side has always had. What the next payout run will actually pay, and any
                  refund credit that will net against it, instead of making the partner add up the cycle rows below. */}
              {data.readyToPayCents > 0 && (
                <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900" data-testid="ready-to-pay">
                  <span className="font-semibold">{fmtCents(data.readyToPayCents, data.currency)}</span> is ready to be paid in the next payout run.
                </div>
              )}
              {data.creditCents > 0 && (
                <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-600" data-testid="refund-credit">
                  A credit of {fmtCents(data.creditCents, data.currency)} (refunds or balance adjustments) will be taken off your next payout.
                </div>
              )}

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <StatCard label="Clicks" value={data.stats.totalClicks} />
                <StatCard label="Conversions" value={data.stats.totalConversions} />
                <StatCard label="Pending" value={fmtCents(data.stats.pendingCents, data.currency)} />
                <StatCard label="Paid to date" value={fmtCents(data.stats.paidCents, data.currency)} />
              </div>
            </div>

            {/* Two columns from lg: the money on the left, what you share and your settings on the right. The right-hand
                column comes first in the page order, so on a phone the codes (the thing to share) are above the ledger. */}
            <div className="grid gap-8 lg:grid-cols-3 lg:items-start">
              <div className="flex flex-col gap-8 min-w-0 lg:col-start-3 lg:row-start-1">
                <section id="codes" className="scroll-mt-24 flex flex-col gap-3">
                  <h2 className="text-lg font-semibold text-gray-900">Your codes</h2>
                  {data.referralCodes.length === 0 ? (
                    <p className="text-sm text-gray-500">
                      No referral code yet — we'll email you as soon as one is set up.
                    </p>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {data.referralCodes.map(code => (
                        <CodeCard key={code.id} code={code} partnerActive={data.active} partnerStatus={data.status} currency={data.currency} />
                      ))}
                    </div>
                  )}
                </section>

                <section id="settings" className="scroll-mt-24 flex flex-col gap-3">
                  <NotificationPrefs token={token} initial={data.notifyConversions} />
                  <ResetLinks token={token} />
                </section>
              </div>

              <div className="flex flex-col gap-8 min-w-0 lg:col-span-2 lg:col-start-1 lg:row-start-1">
                <section id="earnings" className="scroll-mt-24 flex flex-col gap-8">
                  {data.cyclesSummary?.length > 0 && (
                    <div>
                      <h2 className="text-lg font-semibold text-gray-900 mb-1">Payout cycles</h2>
                      <p className="text-xs text-gray-400 mb-3">Cycles and the dates in the lists below are in UTC.</p>
                      <div className="flex flex-col gap-2">
                        {data.cyclesSummary.map(cycle => (
                          <CycleRow key={cycle.key} cycle={cycle} currency={data.currency} />
                        ))}
                        {data.olderUnpaidCents !== 0 && (
                          <div className="border border-gray-200 rounded-xl bg-white px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
                            <div className="font-medium text-gray-900">Earlier cycles</div>
                            <div className={`text-sm ${data.olderUnpaidCents > 0 ? 'font-semibold text-amber-600' : 'text-red-600'}`}>
                              {fmtCents(data.olderUnpaidCents, data.currency)} {data.olderUnpaidCents > 0 ? '— still unpaid' : '— refund credit, nets against future commission'}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  <TrendSection trend={data.trend} mix={data.attributionMix} subMix={data.subMix} currency={data.currency} />

                  <div>
                    <ConversionsSection token={token} initial={data.conversions || []} total={data.conversionsTotal} currency={data.currency} payouts={data.payouts || []} />
                  </div>
                </section>

                <section id="payouts" className="scroll-mt-24">
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="text-lg font-semibold text-gray-900">Payout history</h2>
                    {/* Round 18: a payout record to keep for tax and bookkeeping (the conversions CSV above holds sales only). */}
                    {data.payouts.length > 0 && (
                      <button type="button" className="text-sm text-blue-600 hover:underline" data-testid="payouts-csv"
                        onClick={() => downloadCsv(`passthrough-payouts-${dateStamp()}.csv`, [
                          ['Paid on (UTC)', 'Amount', 'Currency', 'Method', 'Sales from (UTC)', 'Sales to (UTC)', 'Note'],
                          ...data.payouts.map(p => [
                            String(p.paidAt || '').slice(0, 10), (p.amountCents || 0) / 100, p.currency || data.currency || '',
                            p.payoutMethod === 'BANK' ? 'Bank transfer' : p.payoutMethod === 'MOBILE_MONEY' ? 'Mobile money' : '',
                            String(p.periodStart || '').slice(0, 10), String(p.periodEnd || '').slice(0, 10), p.note || '',
                          ]),
                        ])}>
                        Download CSV
                      </button>
                    )}
                  </div>
                  {data.payouts.length === 0 ? (
                    <EmptyState>No payouts yet.</EmptyState>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {data.payouts.map(p => (
                        <li key={p.id} className="text-sm text-gray-700 bg-white border border-gray-200 rounded-xl px-4 py-3">
                          <div className="flex justify-between">
                            <span>{formatDateUtc(p.paidAt)}{p.note ? ` — ${p.note}` : ''}</span>
                            <span className="font-medium">{fmtCents(p.amountCents, p.currency)}</span>
                          </div>
                          <div className="flex items-center gap-3 mt-0.5">
                            {p.periodStart && <span className="text-xs text-gray-400">Sales {formatDateUtc(p.periodStart)} – {formatDateUtc(p.periodEnd)}</span>}
                            <button type="button" className="text-xs text-blue-600 hover:underline"
                              onClick={() => setStatementId(id => (id === p.id ? null : p.id))}>
                              {statementId === p.id ? 'Hide sales' : 'Sales in this payout'}
                            </button>
                          </div>
                          {statementId === p.id && <PayoutStatement token={token} payout={p} currency={p.currency || data.currency} />}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>
            </div>
          </div>
        )}
    </PartnerLayout>
  )
}
