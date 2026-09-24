import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import api, { getErrorMessage } from '../../lib/api'
import Button from '../../components/ui/Button'
import Badge from '../../components/ui/Badge'
import Spinner from '../../components/ui/Spinner'
import Pagination from '../../components/ui/Pagination'
import ConfirmDialog from '../../components/ui/ConfirmDialog'
import { useToast } from '../../components/ui/Toast'
import { formatDate } from '../../lib/utils'

// SECTION 8 AUDIT (feature gap): webhook_events is the durable inbox every
// verified Paystack event lands in — an audit trail and the dedupe record — but
// nothing in the app could show it, and every alert said "check webhook_events".
// This is that view, plus a replay for events that were HELD / FAILED / IGNORED
// (the inbox treats those as finished, so neither Paystack's own "Resend" nor a
// redelivery could ever re-run them).

const PAGE_SIZE = 25
const STATUSES = ['RECEIVED', 'PROCESSED', 'IGNORED', 'HELD', 'FAILED']
const badgeVariant = s => ({ PROCESSED: 'green', RECEIVED: 'amber', IGNORED: 'gray', HELD: 'amber', FAILED: 'red' }[s] || 'gray')

export default function AdminWebhooks() {
  const toast = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  const status = searchParams.get('status') || ''
  const [events, setEvents] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [pending, setPending] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get('/admin/webhook-events', { params: { page, pageSize: PAGE_SIZE, status: status || undefined } })
      setEvents(res.data.data)
      setTotal(res.data.meta.total)
    } catch (err) {
      toast({ message: getErrorMessage(err, 'Failed to load webhook events.'), type: 'error' })
    } finally {
      setLoading(false)
    }
  }, [page, status])

  useEffect(() => { load() }, [load])

  function setStatus(next) {
    setPage(1)
    setSearchParams(next ? { status: next } : {})
  }

  async function runReplay(ev) {
    setBusyId(ev.id)
    try {
      const res = await api.post(`/admin/webhook-events/${ev.id}/replay`)
      const d = res.data.data || {}
      toast({ message: `Replayed → ${d.status}${d.note ? ` (${d.note})` : ''}${d.hint ? `. ${d.hint}` : ''}`, type: d.status === 'HELD' ? 'error' : 'success' })
      load()
    } catch (err) {
      toast({ message: getErrorMessage(err, 'Replay failed.'), type: 'error' })
    } finally {
      setBusyId(null)
      setPending(null)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-gray-900">Webhook events</h1>

      <div className="flex flex-col gap-1">
        <label htmlFor="wh-status" className="text-sm font-medium text-gray-700">Status</label>
        <select id="wh-status" value={status} onChange={e => setStatus(e.target.value)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm w-56">
          <option value="">All</option>
          {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <p className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-md px-3 py-2">
        HELD = an amount/currency mismatch was caught (use Payments → Recheck to accept it). FAILED = processing threw
        and Paystack was told to retry. IGNORED = an event this app doesn't act on, or a reference with no payment row.
        A stuck RECEIVED means the Worker died mid-event. Replay re-runs the stored event through the same handlers a
        live delivery uses; it is safe to repeat.
      </p>

      {loading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : events.length === 0 ? (
        <p className="text-sm text-gray-500">No events found.</p>
      ) : (
        <div className="border border-gray-200 rounded-lg bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200">
                <th className="px-4 py-3">Received</th>
                <th className="px-4 py-3">Event</th>
                <th className="px-4 py-3">Reference</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Tries</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {events.map(ev => (
                <tr key={ev.id}>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{formatDate(ev.receivedAt)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-700">{ev.eventType}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-500">{ev.reference || '—'}</td>
                  <td className="px-4 py-3">
                    <Badge variant={badgeVariant(ev.status)}>{ev.status}</Badge>
                    {ev.error && <div className="text-xs text-red-600 mt-0.5 max-w-xs break-words">{ev.error}</div>}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-500">{ev.attempts}</td>
                  <td className="px-4 py-3 text-right">
                    {ev.replayable && (
                      <Button size="sm" variant="secondary" loading={busyId === ev.id} onClick={() => setPending(ev)}>
                        Replay
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && <Pagination page={page} totalPages={totalPages} onChange={p => setPage(p)} />}

      <ConfirmDialog
        open={!!pending}
        title="Replay this event?"
        message={pending ? `Re-run ${pending.eventType}${pending.reference ? ` (${pending.reference})` : ''} through the webhook handlers. Every handler is idempotent, so this cannot double-fulfil or double-credit.` : ''}
        danger={false}
        loading={!!pending && busyId === pending.id}
        onConfirm={() => runReplay(pending)}
        onCancel={() => setPending(null)}
      />
    </div>
  )
}
