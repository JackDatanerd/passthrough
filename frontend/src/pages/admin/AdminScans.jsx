import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import api from '../../lib/api'
import Button from '../../components/ui/Button'
import Badge from '../../components/ui/Badge'
import Spinner from '../../components/ui/Spinner'
import { useToast } from '../../components/ui/Toast'
import { formatDate, statusLabel, scoreColor } from '../../lib/utils'

const PAGE_SIZE = 25
const STATUSES = ['PENDING', 'SCANNING', 'COMPLETE_PASS', 'COMPLETE_FAIL', 'FIX_PURCHASED', 'FIX_GENERATING', 'FIX_DELIVERED', 'ERROR']

export default function AdminScans() {
  const toast = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  const status = searchParams.get('status') || ''
  const [scans, setScans] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get('/admin/scans', { params: { page, pageSize: PAGE_SIZE, status: status || undefined } })
      setScans(res.data.data)
      setTotal(res.data.meta.total)
    } catch (_) {
      toast({ message: 'Failed to load scans.', type: 'error' })
    } finally {
      setLoading(false)
    }
  }, [page, status])

  useEffect(() => { load() }, [load])

  function setStatus(next) {
    setPage(1)
    setSearchParams(next ? { status: next } : {})
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // SECTION 7 AUDIT (feature gap G7-2): the public verification page had no
  // admin off switch — abuse or a takedown request had no lever here at all.
  async function handleSetVerification(scan, action) {
    setBusyId(scan.id)
    try {
      await api.patch(`/admin/scans/${scan.id}/verification`, { action })
      setScans(prev => prev.map(s => s.id === scan.id
        ? { ...s, verificationStatus: action === 'revoke' ? 'REVOKED' : 'ACTIVE', verificationRevokedReason: action === 'revoke' ? 'ADMIN' : null }
        : s))
      toast({ message: action === 'revoke' ? 'Verification revoked.' : 'Verification restored.', type: 'success' })
    } catch (_) {
      toast({ message: 'Could not update verification.', type: 'error' })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-gray-900">Scans</h1>

      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-gray-700">Status</label>
        <select value={status} onChange={e => setStatus(e.target.value)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm w-56">
          <option value="">All</option>
          {STATUSES.map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}
        </select>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : scans.length === 0 ? (
        <p className="text-sm text-gray-500">No scans found.</p>
      ) : (
        <div className="border border-gray-200 rounded-lg bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200">
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Resume</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">ATS score</th>
                <th className="px-4 py-3">Fix tier</th>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3">Updated</th>
                <th className="px-4 py-3">Verification</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {scans.map(s => (
                <tr key={s.id}>
                  <td className="px-4 py-3 text-gray-600">{s.userEmail || <span className="italic text-gray-400">anonymous</span>}</td>
                  <td className="px-4 py-3 text-gray-600 max-w-[16rem] truncate">{s.resumeOriginalName || '—'}</td>
                  <td className="px-4 py-3">
                    <Badge variant={s.status === 'ERROR' ? 'red' : s.status.startsWith('COMPLETE') || s.status === 'FIX_DELIVERED' ? 'green' : 'gray'}>
                      {statusLabel(s.status)}
                    </Badge>
                  </td>
                  <td className={`px-4 py-3 text-right font-medium ${s.atsScore != null ? scoreColor(s.atsScore) : 'text-gray-300'}`}>
                    {s.atsScore ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-500">{s.fixPurchased ? (s.fixTier || 'FIX') : '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{formatDate(s.createdAt)}</td>
                  <td className="px-4 py-3 text-gray-500">{formatDate(s.updatedAt)}</td>
                  <td className="px-4 py-3">
                    {!s.verificationCode ? (
                      <span className="text-gray-300">—</span>
                    ) : s.verificationStatus === 'REVOKED' ? (
                      <div className="flex items-center gap-2">
                        <Badge variant="gray">Revoked{s.verificationRevokedReason ? ` (${s.verificationRevokedReason})` : ''}</Badge>
                        <button disabled={busyId === s.id} onClick={() => handleSetVerification(s, 'restore')}
                          className="text-xs text-blue-700 hover:text-blue-800 underline disabled:opacity-50">
                          Restore
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <Badge variant="green">Active</Badge>
                        <button disabled={busyId === s.id} onClick={() => handleSetVerification(s, 'revoke')}
                          className="text-xs text-red-600 hover:text-red-700 underline disabled:opacity-50">
                          Revoke
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</Button>
          <span className="text-sm text-gray-500">Page {page} of {totalPages}</span>
          <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
        </div>
      )}
    </div>
  )
}
