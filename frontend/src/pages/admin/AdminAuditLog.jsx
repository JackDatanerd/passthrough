import { useState, useEffect, useCallback } from 'react'
import api from '../../lib/api'
import Badge from '../../components/ui/Badge'
import Spinner from '../../components/ui/Spinner'
import Pagination from '../../components/ui/Pagination'
import Select from '../../components/ui/Select'
import { useToast } from '../../components/ui/Toast'
import { formatDateTime } from '../../lib/utils'
import usePageClamp from '../../hooks/usePageClamp'

const PAGE_SIZE = 20

// FEATURE GAP CLOSED (Section 12 audit): admin_audit_log has recorded admin
// actions on other people's data since the leads section was built (see
// lib/adminAudit.js on the backend) — bulk deletes, status changes, CSV
// exports, and now also user bans/role changes, partner status/payout-link
// changes, and payment reversals. Nothing anywhere ever showed it: the table
// existed to be queried by hand. This is that view.
//
// `detail` is rendered as plain "key: value" pairs rather than raw JSON —
// it never carries personal data (see adminAudit.js's own rule), only ids,
// counts, field names and status transitions, so there's nothing here that
// needs hiding, just formatting for a human to actually read at a glance.
function DetailLine({ detail }) {
  const entries = Object.entries(detail || {}).filter(([, v]) => v !== undefined && v !== null && v !== '')
  if (entries.length === 0) return null
  return (
    <div className="text-xs text-gray-400">
      {entries.map(([k, v]) => `${k}: ${typeof v === 'boolean' ? (v ? 'yes' : 'no') : v}`).join(' · ')}
    </div>
  )
}

const TARGET_TYPES = [
  'user', 'partner', 'payout', 'payment',
  'employer_lead', 'employer_leads', 'employer_lead_suppression',
]

export default function AdminAuditLog() {
  const toast = useToast()
  const [entries, setEntries] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [targetType, setTargetType] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get('/admin/audit-log', { params: { page, pageSize: PAGE_SIZE, targetType: targetType || undefined } })
      setEntries(res.data.data)
      setTotal(res.data.meta.total)
    } catch (_) {
      toast({ message: 'Failed to load the audit log.', type: 'error' })
    } finally {
      setLoading(false)
    }
  }, [page, targetType])

  useEffect(() => { load() }, [load])
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  usePageClamp({ page, total, pageSize: PAGE_SIZE, setPage, loading })
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Audit log</h1>
        <Select aria-label="Filter audit log by target type" size="sm" wrapperClassName="w-fit"
          value={targetType} onChange={e => { setPage(1); setTargetType(e.target.value) }}>
          <option value="">All types</option>
          {TARGET_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </Select>
      </div>
      <p className="text-xs text-gray-400">
        Every admin action taken on another person's data — who did what, to which record, and when.
      </p>
      {loading ? (
        <div className="flex justify-center py-8"><Spinner size="sm" /></div>
      ) : entries.length === 0 ? (
        <p className="text-sm text-gray-400 italic">No audit entries recorded.</p>
      ) : (
        <div className="border border-gray-200 rounded-lg bg-white divide-y divide-gray-100">
          {entries.map(e => (
            <div key={e.id} className="p-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <Badge variant="gray">{e.action}</Badge>
                  <span className="text-xs text-gray-400 truncate">{e.targetType}{e.targetId ? ` · ${e.targetId}` : ''}</span>
                </div>
                <div className="text-xs text-gray-400 whitespace-nowrap">
                  {e.actorEmail || 'unknown admin'} · {formatDateTime(e.createdAt)}
                </div>
              </div>
              <DetailLine detail={e.detail} />
            </div>
          ))}
        </div>
      )}
      {totalPages > 1 && (
        <Pagination page={page} totalPages={totalPages} onChange={p => setPage(p)} compact className="flex items-center justify-center gap-3 mt-1" />
      )}
    </div>
  )
}
