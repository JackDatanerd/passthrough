import { useState, useEffect } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import api from '../lib/api'
import { copyToClipboard, formatCents } from '../lib/utils'
import Spinner from '../components/ui/Spinner'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'

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

function StatCard({ label, value }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="text-xs uppercase tracking-wide text-gray-400 mb-1">{label}</div>
      <div className="text-2xl font-bold text-gray-900">{value}</div>
    </div>
  )
}

// The link itself — built client-side from window.location.origin, since
// this page is served from the same domain the link should point at. This
// is the one thing that was missing entirely before: a code alone isn't
// shareable, a URL is.
function ShareLink({ code }) {
  const [copied, setCopied] = useState(false)
  const url = `${window.location.origin}/?ref=${code}`

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
function isCodeLive(code) {
  if (!code.active) return false
  if (code.expiresAt && new Date(code.expiresAt) < new Date()) return false
  if (code.usageLimit != null && (code.usesSoFar || 0) >= code.usageLimit) return false
  return true
}

function CodeCard({ code }) {
  const prices = Object.entries(code.tierPrices || {})
  const live = isCodeLive(code)
  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-white">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="font-mono text-lg font-bold text-blue-700">{code.code}</div>
        <span className={`text-xs px-2 py-0.5 rounded-full ${
          code.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
          {code.active ? 'Active' : 'Inactive'}
        </span>
      </div>
      <ShareLink code={code.code} />
      <div className="text-sm text-gray-500 mt-3">
        {prices.map(([tier, cents]) => `${tier}: $${(cents / 100).toFixed(0)}`).join(' · ')}
      </div>
      <div className="text-sm text-gray-500 mt-1">
        {code.clicks || 0} clicks · {code.usesSoFar || 0} redemption{code.usesSoFar === 1 ? '' : 's'}
        {code.usageLimit ? ` (limit ${code.usageLimit})` : ''}
      </div>
      <p className="text-xs text-gray-400 mt-2">
        {live ? (
          <>Anyone who visits your link gets the discount automatically. They can also just tell
          people the code <span className="font-mono">{code.code}</span> directly — there's a
          "have a code?" box at checkout too.</>
        ) : (
          <>This code isn't live anymore — links using it will fall back to standard pricing and
          won't earn you commission. Ask us about setting up a new one.</>
        )}
      </p>
    </div>
  )
}

export default function PartnerDashboard() {
  const [params] = useSearchParams()
  const token = params.get('token')

  const [loading, setLoading] = useState(true)
  const [invalid, setInvalid] = useState(false)
  const [data, setData] = useState(null)

  useEffect(() => {
    if (!token) { setInvalid(true); setLoading(false); return }
    api.get(`/partners/dashboard?token=${encodeURIComponent(token)}`)
      .then(res => setData(res.data.data))
      .catch(() => setInvalid(true))
      .finally(() => setLoading(false))
  }, [token])

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <Navbar />
      <main className="flex-1 max-w-3xl mx-auto w-full px-4 py-10">
        {loading ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : invalid ? (
          <div className="bg-white rounded-lg border border-gray-200 p-8">
            <h1 className="text-xl font-bold text-gray-900 mb-2">Link not valid</h1>
            <p className="text-sm text-gray-600">
              This dashboard link is invalid or has expired. Ask us to resend it.
            </p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-6 flex-wrap gap-2">
              <h1 className="text-2xl font-bold text-gray-900">
                {data.name}'s Passthrough dashboard
              </h1>
              <Link to={`/partner/payout-details?token=${token}`}
                className="text-sm text-blue-600 hover:underline">
                Update payout details →
              </Link>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
              <StatCard label="Clicks" value={data.stats.totalClicks} />
              <StatCard label="Conversions" value={data.stats.totalConversions} />
              <StatCard label="Pending" value={fmtCents(data.stats.pendingCents)} />
              <StatCard label="Paid to date" value={fmtCents(data.stats.paidCents)} />
            </div>

            <h2 className="text-lg font-semibold text-gray-900 mb-3">Your codes</h2>
            {data.referralCodes.length === 0 ? (
              <p className="text-sm text-gray-500 mb-8">
                No referral code yet — we'll email you as soon as one is set up.
              </p>
            ) : (
              <div className="flex flex-col gap-3 mb-8">
                {data.referralCodes.map(code => <CodeCard key={code.id} code={code} />)}
              </div>
            )}

            <h2 className="text-lg font-semibold text-gray-900 mb-3">Payout history</h2>
            {data.payouts.length === 0 ? (
              <p className="text-sm text-gray-500">No payouts yet.</p>
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
          </>
        )}
      </main>
      <Footer />
    </div>
  )
}
