import { useState, useEffect, useCallback } from 'react'
import api from '../../lib/api'
import Badge from '../../components/ui/Badge'
import Spinner from '../../components/ui/Spinner'
import { useToast } from '../../components/ui/Toast'
import { formatDate } from '../../lib/utils'
import useLatestRequest from '../../hooks/useLatestRequest'

// Verify round 8 (feature gap): reports a reader sent from a public verification page
// (POST /api/verify/:code/report), with the page's current state and the same Revoke lever the table
// below has. Revoking settles the page's open reports on the server; Dismiss / Done close one by hand.
const REASON_LABEL = { FAKE: 'Looks fake / misleading', WRONG: 'Something is wrong', MINE: 'Owner wants it changed', OTHER: 'Other' }

export default function VerificationReports({ onChanged }) {
  const toast = useToast()
  const begin = useLatestRequest()
  const [reports, setReports] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)

  // VERIFY ROUND 10 (bug): the panel showed the first 25 reports and never refilled, so clearing those 25 emptied
  // the list and hid the panel while the "(total)" still counted more waiting. `silent` reloads in place (no
  // spinner) after each review so the next reports slide up; the server lists OPEN reports oldest-first.
  const load = useCallback(async (silent = false) => {
    const isCurrent = begin()
    if (!silent) setLoading(true)
    try {
      const res = await api.get('/admin/verification-reports', { signal: isCurrent.signal, params: { status: 'OPEN', pageSize: 25 } })
      if (!isCurrent()) return
      setReports(res.data.data)
      setTotal(res.data.meta.total)
    } catch (_) {
      if (!isCurrent()) return
      toast({ message: 'Failed to load verification reports.', type: 'error' })
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [])
  useEffect(() => { load() }, [load])

  async function review(report, status) {
    setBusyId(report.id)
    try {
      await api.patch(`/admin/verification-reports/${report.id}`, { status })
      setReports(prev => prev.filter(r => r.id !== report.id))
      setTotal(t => Math.max(0, t - 1))
      await load(true)
    } catch (_) {
      toast({ message: 'Could not update the report.', type: 'error' })
    } finally {
      setBusyId(null)
    }
  }

  async function revoke(report) {
    setBusyId(report.id)
    try {
      await api.patch(`/admin/scans/${report.scanId}/verification`, { action: 'revoke' })
      toast({ message: 'Verification revoked.', type: 'success' })
      await load(true)
      if (onChanged) onChanged()
    } catch (_) {
      toast({ message: 'Could not revoke that page.', type: 'error' })
    } finally {
      setBusyId(null)
    }
  }

  if (loading && reports.length === 0) return <div className="flex justify-center py-4"><Spinner /></div>
  if (reports.length === 0 && total === 0) return null   // nothing waiting: the panel stays out of the way

  return (
    <section aria-label="Open verification reports" className="border border-amber-200 bg-amber-50 rounded-lg p-4 flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-gray-900">Open verification reports ({total})</h2>
      {total > reports.length && (
        <p className="text-xs text-gray-500">Showing the oldest {reports.length}. The rest appear as these are cleared.</p>
      )}
      <ul className="flex flex-col gap-2">
        {reports.map(r => (
          <li key={r.id} className="bg-white border border-gray-200 rounded-md p-3 text-sm flex flex-col gap-1">
            <div className="flex items-center gap-2 flex-wrap">
              <code className="font-mono text-xs">{r.code}</code>
              <Badge variant="amber">{REASON_LABEL[r.reason] || r.reason}</Badge>
              <Badge variant={r.pageStatus === 'ACTIVE' ? 'green' : 'gray'}>{r.pageStatus === 'GONE' ? 'Page deleted' : r.pageStatus === 'ACTIVE' ? 'Active' : 'Revoked'}</Badge>
              <span className="text-xs text-gray-400">{formatDate(r.createdAt)}</span>
            </div>
            {r.details && <p className="text-gray-700 whitespace-pre-wrap break-words">{r.details}</p>}
            {r.reporterEmail && <p className="text-xs text-gray-500 break-all">Reply to: {r.reporterEmail}</p>}
            <div className="flex items-center gap-3 mt-1">
              {r.pageStatus === 'ACTIVE' && r.scanId && (
                <button type="button" disabled={busyId === r.id} onClick={() => revoke(r)}
                  className="text-xs text-red-600 hover:text-red-700 underline disabled:opacity-50">Revoke page</button>
              )}
              <button type="button" disabled={busyId === r.id} onClick={() => review(r, 'ACTIONED')}
                className="text-xs text-blue-700 hover:text-blue-800 underline disabled:opacity-50">Mark done</button>
              <button type="button" disabled={busyId === r.id} onClick={() => review(r, 'DISMISSED')}
                className="text-xs text-gray-500 hover:text-gray-700 underline disabled:opacity-50">Dismiss</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
