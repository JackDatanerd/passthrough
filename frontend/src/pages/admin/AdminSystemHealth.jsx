import { useState, useEffect, useCallback } from 'react'
import api from '../../lib/api'
import Badge from '../../components/ui/Badge'
import Spinner from '../../components/ui/Spinner'
import Pagination from '../../components/ui/Pagination'
import { useToast } from '../../components/ui/Toast'
import { formatDate } from '../../lib/utils'

const PAGE_SIZE = 15

function EmailLogsSection() {
  const toast = useToast()
  const [logs, setLogs] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get('/admin/email-logs', { params: { page, pageSize: PAGE_SIZE, status: status || undefined } })
      setLogs(res.data.data)
      setTotal(res.data.meta.total)
    } catch (_) {
      toast({ message: 'Failed to load email logs.', type: 'error' })
    } finally {
      setLoading(false)
    }
  }, [page, status])

  useEffect(() => { load() }, [load])
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-gray-900">Email delivery log</h2>
        <select value={status} onChange={e => { setPage(1); setStatus(e.target.value) }}
          className="rounded-md border border-gray-300 px-2 py-1 text-xs">
          <option value="">All statuses</option>
          <option value="sent">Sent</option>
          <option value="failed">Failed</option>
        </select>
      </div>
      {loading ? (
        <div className="flex justify-center py-8"><Spinner size="sm" /></div>
      ) : logs.length === 0 ? (
        <p className="text-sm text-gray-400 italic">No emails logged.</p>
      ) : (
        <div className="border border-gray-200 rounded-lg bg-white divide-y divide-gray-100">
          {logs.map(l => (
            <div key={l.id} className="p-3 flex items-center justify-between gap-3 text-sm">
              <div className="min-w-0">
                <div className="font-medium text-gray-900 truncate">{l.subject}</div>
                <div className="text-xs text-gray-400">
                  to {l.to} · {l.template} · {formatDate(l.sentAt)}
                  {l.error && <span className="text-red-500"> · {l.error}</span>}
                </div>
              </div>
              <Badge variant={l.status === 'sent' ? 'green' : 'red'}>{l.status}</Badge>
            </div>
          ))}
        </div>
      )}
      {totalPages > 1 && (
        <Pagination page={page} totalPages={totalPages} onChange={p => setPage(p)} compact className="flex items-center justify-center gap-3 mt-3" />
      )}
    </div>
  )
}

function AlertsSection() {
  const toast = useToast()
  const [alerts, setAlerts] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get('/admin/alerts', { params: { page, pageSize: PAGE_SIZE } })
      setAlerts(res.data.data)
      setTotal(res.data.meta.total)
    } catch (_) {
      toast({ message: 'Failed to load alerts.', type: 'error' })
    } finally {
      setLoading(false)
    }
  }, [page])

  useEffect(() => { load() }, [load])
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div>
      <h2 className="font-semibold text-gray-900 mb-3">Alert history</h2>
      <p className="text-xs text-gray-400 mb-3">
        Every critical alert (payment/webhook failures, ledger write failures, signature mismatches) is recorded
        here regardless of whether the notification email itself succeeded — so a missed or filtered email is never the only record.
      </p>
      {loading ? (
        <div className="flex justify-center py-8"><Spinner size="sm" /></div>
      ) : alerts.length === 0 ? (
        <p className="text-sm text-gray-400 italic">No alerts recorded.</p>
      ) : (
        <div className="border border-gray-200 rounded-lg bg-white divide-y divide-gray-100">
          {alerts.map(a => (
            <details key={a.id} className="p-3 text-sm">
              <summary className="flex items-center justify-between gap-3 cursor-pointer list-none">
                <div className="min-w-0">
                  <div className="font-medium text-gray-900 truncate">{a.subject}</div>
                  <div className="text-xs text-gray-400">{formatDate(a.createdAt)}</div>
                </div>
                <Badge variant={a.emailed ? 'gray' : 'red'}>{a.emailed ? 'Emailed' : 'Email failed'}</Badge>
              </summary>
              <pre className="mt-2 text-xs text-gray-600 whitespace-pre-wrap bg-gray-50 rounded-md p-2">{a.message}</pre>
            </details>
          ))}
        </div>
      )}
      {totalPages > 1 && (
        <Pagination page={page} totalPages={totalPages} onChange={p => setPage(p)} compact className="flex items-center justify-center gap-3 mt-3" />
      )}
    </div>
  )
}

export default function AdminSystemHealth() {
  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-2xl font-bold text-gray-900">System Health</h1>
      <AlertsSection />
      <EmailLogsSection />
    </div>
  )
}
