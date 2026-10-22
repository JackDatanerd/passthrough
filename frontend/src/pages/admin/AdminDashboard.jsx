import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import api from '../../lib/api'
import { useApi } from '../../hooks/useApi'
import Spinner from '../../components/ui/Spinner'
import Badge from '../../components/ui/Badge'
import { formatCents, formatDate, cn } from '../../lib/utils'
import StatCard from '../../components/ui/StatCard'
import Alert from '../../components/ui/Alert'

export default function AdminDashboard() {
  const [data, setData] = useState(null)
  const { error, execute } = useApi()

  useEffect(() => {
    execute(() => api.get('/admin/dashboard'), { fallback: 'Failed to load dashboard.' })
      .then(payload => setData(payload.data))
      .catch(() => {})
  }, [])

  if (error) return <p role="alert" className="text-sm text-red-600">{error}</p>
  if (!data) return <div className="flex justify-center py-16"><Spinner /></div>

  const { revenue, totalPendingCommissionCents, promo, openItems, recentAlerts, webhookHealth, currency, otherCurrency } = data
  // Every money figure on this page is in the Worker's active currency (an older Worker sends none: USD, as before).
  const money = cents => formatCents(cents, currency || 'USD')
  const leftOut = (otherCurrency?.payments || 0) + (otherCurrency?.ledgerRows || 0)

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Dashboard</h1>
        {leftOut > 0 && (
          <Alert variant="warning" className="mb-4">
            Totals below count {currency || 'USD'} only. {otherCurrency.payments > 0 && `${otherCurrency.payments} payment${otherCurrency.payments === 1 ? '' : 's'} `}
            {otherCurrency.payments > 0 && otherCurrency.ledgerRows > 0 && 'and '}
            {otherCurrency.ledgerRows > 0 && `${otherCurrency.ledgerRows} commission row${otherCurrency.ledgerRows === 1 ? '' : 's'} `}
            in another currency {leftOut === 1 ? 'is' : 'are'} not included — see Payments and Partners for those.
          </Alert>
        )}
        <div className="grid sm:grid-cols-3 gap-4">
          <StatCard label="Revenue today" value={money(revenue.todayCents)} />
          <StatCard label="Revenue this week" value={money(revenue.weekCents)} />
          <StatCard label="Revenue this month" value={money(revenue.monthCents)}
            sub={revenue.monthPartialRefundsCents > 0 ? `net of ${money(revenue.monthPartialRefundsCents)} partially refunded` : undefined} />
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <div className="border border-gray-200 rounded-lg p-5 bg-white">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-gray-900">Partner commissions</h2>
            <Link to="/admin/partners" className="text-xs text-blue-600 hover:underline">View partners →</Link>
          </div>
          <div className="text-3xl font-bold text-gray-900">{money(totalPendingCommissionCents)}</div>
          <div className="text-sm text-gray-400 mt-1">Pending across all partners</div>
        </div>

        <div className="border border-gray-200 rounded-lg p-5 bg-white">
          <h2 className="font-semibold text-gray-900 mb-3">Pricing status</h2>
          <div className="flex items-center gap-2 mb-2">
            <Badge variant={promo.active ? 'green' : 'gray'}>{promo.active ? `${promo.label || 'Promo'} active` : 'Standard pricing'}</Badge>
            {promo.source === 'admin' && <Badge variant="gray">set in Promotions</Badge>}
            {promo.endsAt && (
              <span className="text-xs text-gray-400">
                {promo.active ? 'ends' : 'ended'} {formatDate(promo.endsAt)}
              </span>
            )}
          </div>
          {promo.priceTableMissing || !promo.standardCents ? (
            // The Worker sends null price tables when PAYSTACK_CURRENCY has none; every checkout is refused until one exists.
            <Alert variant="error">
              No price table for {currency || 'the configured currency'}, so checkout is refused. Add its prices to PRICES_BY_CURRENCY in
              constants.js, or set PAYSTACK_CURRENCY back to a supported currency.
            </Alert>
          ) : (
            <div className="text-sm text-gray-600 grid grid-cols-3 gap-2">
              {['FIX', 'BADGE', 'FIX_PLAIN'].map(tier => (
                <div key={tier}>
                  <div className="text-xs text-gray-400">{tier}</div>
                  <div className={cn(promo.active && 'line-through text-gray-400')}>
                    {money(promo.standardCents[tier])}
                  </div>
                  {promo.active && promo.promoCents && <div className="text-green-700 font-semibold">{money(promo.promoCents[tier])}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div>
        <h2 className="font-semibold text-gray-900 mb-3">Needs attention</h2>
        {/* Webhooks round 12 (W3): `unrecovered` (round 11) — sales newer than the last charge.success received — not the raw
            count, so the banner clears when webhooks flow again instead of staying lit for the whole 7-day window. */}
        {/* Webhooks round 17 (G1): refused deliveries (bad signature / IP) since the last one that got through. */}
        {webhookHealth?.rejectedSinceLastEvent?.length > 0 && (
          <Link to="/admin/webhooks" className="block mb-4 text-sm text-red-800 bg-red-50 border border-red-200 rounded-md px-3 py-2 hover:border-red-300">
            {webhookHealth.rejectedSinceLastEvent.map(p => (p === 'resend' ? 'Resend' : 'Paystack')).join(' and ')} webhook deliveries are reaching this app but being refused
            (wrong or rotated signing key, or a blocked source IP) — nothing has got through since. Check the signing key →
          </Link>
        )}
        {webhookHealth?.available && (webhookHealth.unrecovered ?? webhookHealth.paidWithoutEvent) > 0 && (
          <Link to="/admin/webhooks" className="block mb-4 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 hover:border-amber-300">
            {webhookHealth.unrecovered ?? webhookHealth.paidWithoutEvent} paid sale{(webhookHealth.unrecovered ?? webhookHealth.paidWithoutEvent) === 1 ? ' has' : 's have'} no Paystack webhook on record
            (last 7 days) — payments are being settled without webhooks reaching this app. Check the webhook URL and signing key →
          </Link>
        )}
        <div className="grid sm:grid-cols-3 lg:grid-cols-6 gap-4">
          <Link to="/admin/scans?status=ERROR" className="border border-gray-200 rounded-lg p-4 bg-white hover:border-gray-300">
            <div className="text-xs text-gray-400">Errored scans (7d)</div>
            <div className={cn('text-xl font-bold', openItems.erroredScansThisWeek > 0 ? 'text-red-600' : 'text-gray-900')}>
              {openItems.erroredScansThisWeek}
            </div>
          </Link>
          <div className="border border-gray-200 rounded-lg p-4 bg-white">
            <div className="text-xs text-gray-400">Stuck scans</div>
            <div className={cn('text-xl font-bold', openItems.stuckScans > 0 ? 'text-amber-600' : 'text-gray-900')}>
              {openItems.stuckScans}
            </div>
          </div>
          <Link to="/admin/payments?status=PENDING" className="border border-gray-200 rounded-lg p-4 bg-white hover:border-gray-300">
            <div className="text-xs text-gray-400">Stale pending payments</div>
            <div className={cn('text-xl font-bold', openItems.stalePendingPayments > 0 ? 'text-amber-600' : 'text-gray-900')}>
              {openItems.stalePendingPayments}
            </div>
          </Link>
          {/* Webhooks round 13 (G1): payments held DISPUTED, and which auto-accept deadline is nearest. */}
          <Link to="/admin/payments?status=DISPUTED" className="border border-gray-200 rounded-lg p-4 bg-white hover:border-gray-300">
            <div className="text-xs text-gray-400">Open disputes</div>
            <div className={cn('text-xl font-bold', openItems.openDisputes > 0 ? 'text-red-600' : 'text-gray-900')}>
              {openItems.openDisputes || 0}
            </div>
            {openItems.answeredDisputes > 0 && openItems.openDisputes > 0 && (
              <div className="text-xs mt-0.5 text-gray-500">{openItems.answeredDisputes} answered, waiting on Paystack / the bank</div>
            )}
            {openItems.nextDisputeDueAt && (
              <div className={cn('text-xs mt-0.5', openItems.overdueDisputes > 0 ? 'text-red-600' : 'text-amber-700')}>
                {openItems.overdueDisputes > 0 ? `${openItems.overdueDisputes} past deadline` : `next due ${formatDate(openItems.nextDisputeDueAt)}`}
              </div>
            )}
          </Link>
          <Link to="/admin/webhooks?status=ATTENTION" className="border border-gray-200 rounded-lg p-4 bg-white hover:border-gray-300">
            <div className="text-xs text-gray-400">Webhook events to look at</div>
            <div className={cn('text-xl font-bold', openItems.webhookEventsNeedingAttention > 0 ? 'text-amber-600' : 'text-gray-900')}>
              {openItems.webhookEventsNeedingAttention || 0}
            </div>
          </Link>
          <Link to="/admin/leads?status=NEW" className="border border-gray-200 rounded-lg p-4 bg-white hover:border-gray-300">
            <div className="text-xs text-gray-400">Leads to work (new)</div>
            <div className={cn('text-xl font-bold', openItems.newLeads > 0 ? 'text-amber-600' : 'text-gray-900')}>
              {openItems.newLeads}
            </div>
            <div className="text-xs text-gray-400 mt-0.5">{openItems.leadsThisWeek} arrived in the last 7 days</div>
          </Link>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-gray-900">Recent alerts</h2>
          <Link to="/admin/health" className="text-xs text-blue-600 hover:underline">View all →</Link>
        </div>
        {recentAlerts.length === 0 ? (
          <p className="text-sm text-gray-400 italic">No alerts recorded.</p>
        ) : (
          <div className="border border-gray-200 rounded-lg bg-white divide-y divide-gray-100">
            {recentAlerts.map(a => (
              <div key={a.id} className="p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-gray-900 truncate">{a.subject}</div>
                  <div className="text-xs text-gray-400">{formatDate(a.createdAt)}</div>
                </div>
                <Badge variant={a.emailed ? 'gray' : 'red'}>{a.emailed ? 'Emailed' : 'Email failed'}</Badge>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
