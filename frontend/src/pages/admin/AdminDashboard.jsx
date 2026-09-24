import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import api from '../../lib/api'
import { useApi } from '../../hooks/useApi'
import Spinner from '../../components/ui/Spinner'
import Badge from '../../components/ui/Badge'
import { formatCents, formatDate, cn } from '../../lib/utils'

function StatCard({ label, value, sub }) {
  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-white">
      <div className="text-xs uppercase tracking-wide text-gray-400 mb-1">{label}</div>
      <div className="text-2xl font-bold text-gray-900">{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-1">{sub}</div>}
    </div>
  )
}

export default function AdminDashboard() {
  const [data, setData] = useState(null)
  const { error, execute } = useApi()

  useEffect(() => {
    execute(() => api.get('/admin/dashboard'), { fallback: 'Failed to load dashboard.' })
      .then(payload => setData(payload.data))
      .catch(() => {})
  }, [])

  if (error) return <p className="text-sm text-red-600">{error}</p>
  if (!data) return <div className="flex justify-center py-16"><Spinner /></div>

  const { revenue, totalPendingCommissionCents, promo, openItems, recentAlerts } = data

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Dashboard</h1>
        <div className="grid sm:grid-cols-3 gap-4">
          <StatCard label="Revenue today" value={formatCents(revenue.todayCents)} />
          <StatCard label="Revenue this week" value={formatCents(revenue.weekCents)} />
          <StatCard label="Revenue this month" value={formatCents(revenue.monthCents)} />
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <div className="border border-gray-200 rounded-lg p-5 bg-white">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-gray-900">Partner commissions</h2>
            <Link to="/admin/partners" className="text-xs text-blue-600 hover:underline">View partners →</Link>
          </div>
          <div className="text-3xl font-bold text-gray-900">{formatCents(totalPendingCommissionCents)}</div>
          <div className="text-sm text-gray-400 mt-1">Pending across all partners</div>
        </div>

        <div className="border border-gray-200 rounded-lg p-5 bg-white">
          <h2 className="font-semibold text-gray-900 mb-3">Pricing status</h2>
          <div className="flex items-center gap-2 mb-2">
            <Badge variant={promo.active ? 'green' : 'gray'}>{promo.active ? 'Promo active' : 'Standard pricing'}</Badge>
            {promo.endsAt && (
              <span className="text-xs text-gray-400">
                {promo.active ? 'ends' : 'ended'} {formatDate(promo.endsAt)}
              </span>
            )}
          </div>
          <div className="text-sm text-gray-600 grid grid-cols-3 gap-2">
            {['FIX', 'BADGE', 'FIX_PLAIN'].map(tier => (
              <div key={tier}>
                <div className="text-xs text-gray-400">{tier}</div>
                <div className={cn(promo.active && 'line-through text-gray-400')}>
                  {formatCents(promo.standardCents[tier])}
                </div>
                {promo.active && <div className="text-green-700 font-semibold">{formatCents(promo.promoCents[tier])}</div>}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div>
        <h2 className="font-semibold text-gray-900 mb-3">Needs attention</h2>
        <div className="grid sm:grid-cols-3 lg:grid-cols-5 gap-4">
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
