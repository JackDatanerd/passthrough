import { useState, useEffect } from 'react'
import { NavLink, Link, Outlet } from 'react-router-dom'
import api from '../../lib/api'
import { cn, formatCents } from '../../lib/utils'

const NAV = [
  { to: '/admin/dashboard', label: 'Dashboard' },
  { to: '/admin/partners',  label: 'Partners' },
  { to: '/admin/users',     label: 'Users' },
  { to: '/admin/scans',     label: 'Scans' },
  { to: '/admin/payments',  label: 'Payments' },
  { to: '/admin/webhooks',  label: 'Webhooks' },
  { to: '/admin/leads',     label: 'Leads' },
  { to: '/admin/health',    label: 'System Health' },
]

// A tiny always-visible strip of the numbers Jack actually checks daily —
// fetched once here rather than duplicated into every page, so switching
// between admin sections doesn't re-trigger the same summary call.
function TopStrip() {
  const [stats, setStats] = useState(null)
  // AUDIT FIX (Admin panel re-audit): "N items need attention" used to be
  // plain text with nowhere to go — the breakdown existed on the Dashboard
  // page, but not from wherever you actually were in the panel when you
  // noticed the number. Click to expand right here instead of forcing a
  // navigation away from whatever you were doing.
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    api.get('/admin/dashboard').then(res => setStats(res.data.data)).catch(() => {})
  }, [])

  if (!stats) return <div className="h-10" />

  const { erroredScansThisWeek, stuckScans, stalePendingPayments } = stats.openItems
  // NEW leads are work waiting for a person, the same as an errored scan is —
  // the dashboard computed the number but nothing outside its own page showed it.
  const newLeads = stats.openItems.newLeads || 0
  const openCount = erroredScansThisWeek + stuckScans + stalePendingPayments + newLeads

  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex flex-wrap gap-6 items-center">
        <div>
          <span className="text-gray-400">Owed to partners: </span>
          <span className="font-semibold text-gray-900">{formatCents(stats.totalPendingCommissionCents)}</span>
        </div>
        <div>
          <span className="text-gray-400">Revenue today: </span>
          <span className="font-semibold text-gray-900">{formatCents(stats.revenue.todayCents)}</span>
        </div>
        <div>
          <span className="text-gray-400">Promo: </span>
          <span className={cn('font-semibold', stats.promo.active ? 'text-green-700' : 'text-gray-500')}>
            {stats.promo.active ? 'Active' : 'Inactive'}
          </span>
        </div>
        {openCount > 0 && (
          <button onClick={() => setExpanded(e => !e)}
            className="text-amber-600 font-semibold hover:underline">
            {openCount} item{openCount === 1 ? '' : 's'} need attention {expanded ? '▲' : '▼'}
          </button>
        )}
      </div>
      {expanded && openCount > 0 && (
        <div className="flex flex-wrap gap-4 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 text-xs">
          {erroredScansThisWeek > 0 && (
            <Link to="/admin/scans?status=ERROR" className="text-amber-800 hover:underline">
              {erroredScansThisWeek} errored scan{erroredScansThisWeek === 1 ? '' : 's'} (7d) →
            </Link>
          )}
          {stuckScans > 0 && (
            <Link to="/admin/scans" className="text-amber-800 hover:underline">
              {stuckScans} stuck scan{stuckScans === 1 ? '' : 's'} (sort by Updated) →
            </Link>
          )}
          {newLeads > 0 && (
            <Link to="/admin/leads?status=NEW" className="text-amber-800 hover:underline">
              {newLeads} new lead{newLeads === 1 ? '' : 's'} →
            </Link>
          )}
          {stalePendingPayments > 0 && (
            <Link to="/admin/payments?status=PENDING" className="text-amber-800 hover:underline">
              {stalePendingPayments} stale pending payment{stalePendingPayments === 1 ? '' : 's'} →
            </Link>
          )}
        </div>
      )}
    </div>
  )
}

export default function AdminLayout() {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="border-b border-gray-200 bg-white">
        <div className="max-w-6xl mx-auto px-4 py-3 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="font-bold text-gray-900">Passthrough Admin</span>
            <NavLink to="/dashboard" className="text-xs text-gray-400 hover:text-gray-600">
              ← Back to site
            </NavLink>
          </div>
          <TopStrip />
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-6 flex flex-col sm:flex-row gap-6">
        <aside className="w-full sm:w-44 sm:shrink-0">
          <nav className="flex sm:flex-col gap-1 overflow-x-auto sm:overflow-visible pb-2 sm:pb-0">
            {NAV.map(item => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => cn(
                  'px-3 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap shrink-0',
                  isActive ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-100'
                )}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </aside>

        <main className="flex-1 min-w-0">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
