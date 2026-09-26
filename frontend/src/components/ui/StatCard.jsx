import { cn } from '../../lib/utils'

// FEATURE GAP CLOSED (Section 11 audit): this exact card — a small uppercase
// label over a big bold value — was copy-pasted independently into
// AdminDashboard.jsx and PartnerDashboard.jsx, and had already drifted apart
// (only AdminDashboard's copy grew a `sub` line), plus a THIRD copy inlined
// directly in PartnerDetail.jsx with no local function at all, using a
// smaller value size and a custom color for one of its three cards. One
// shared component instead of three drifting copies — same story
// Pagination.jsx already tells for the Prev/Next block.
//
//   <StatCard label="Clicks" value={data.stats.totalClicks} />
//   <StatCard label="Total pending" value={fmtCents(cents)} valueClassName="text-amber-600" size="md" />
//   <StatCard label="Payout details" size="md"><PayoutDetailsSummary partner={partner} /></StatCard>
//
// `children`, when given, replaces the plain value line entirely — that's
// what PartnerDetail's third card needs (it renders <PayoutDetailsSummary>,
// not a formatted number). The label always keeps a bit of space below it
// (mb-1): that's what both real, already-extracted StatCards agreed on
// (AdminDashboard's and PartnerDashboard's, 7 call sites between them) — only
// PartnerDetail's un-extracted, hand-copied blocks were inconsistent about
// it, which is exactly the kind of drift extracting this component removes.
export default function StatCard({ label, value, sub, size = 'lg', valueClassName = 'text-gray-900', children }) {
  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-white">
      <div className="text-xs uppercase tracking-wide text-gray-400 mb-1">{label}</div>
      {children ?? (
        <div className={cn('font-bold', size === 'lg' ? 'text-2xl' : 'text-xl', valueClassName)}>{value}</div>
      )}
      {sub && <div className="text-xs text-gray-400 mt-1">{sub}</div>}
    </div>
  )
}
