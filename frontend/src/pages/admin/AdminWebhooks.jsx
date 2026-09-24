import { Fragment, useState, useEffect, useCallback } from 'react'
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
// ATTENTION = FAILED + HELD + RECEIVED for over 15 minutes (the Worker died mid-event): what needs a person.
const badgeVariant = s => ({ PROCESSED: 'green', RECEIVED: 'amber', IGNORED: 'gray', HELD: 'amber', FAILED: 'red' }[s] || 'gray')

export default function AdminWebhooks() {
  const toast = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  const status = searchParams.get('status') || ''
  const referenceQ = searchParams.get('reference') || ''
  const typeQ = searchParams.get('type') || ''
  const [refDraft, setRefDraft] = useState(referenceQ)
  const [typeDraft, setTypeDraft] = useState(typeQ)
  // ROUND-3 AUDIT (feature gap): "what exactly did Paystack send?" used to mean SQL.
  const [openId, setOpenId] = useState(null)
  const [payloads, setPayloads] = useState({})   // id -> payload | 'loading' | 'error'
  const [events, setEvents] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [pending, setPending] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get('/admin/webhook-events', { params: { page, pageSize: PAGE_SIZE, status: status || undefined, reference: referenceQ || undefined, type: typeQ || undefined } })
      setEvents(res.data.data)
      setTotal(res.data.meta.total)
    } catch (err) {
      toast({ message: getErrorMessage(err, 'Failed to load webhook events.'), type: 'error' })
    } finally {
      setLoading(false)
    }
  }, [page, status, referenceQ, typeQ])

  useEffect(() => { load() }, [load])

  function applyFilters(next = {}) {
    const merged = { status, reference: referenceQ, type: typeQ, ...next }
    const params = {}
    for (const [k, v] of Object.entries(merged)) if (v) params[k] = v
    setPage(1)
    setSearchParams(params)
  }
  const setStatus = next => applyFilters({ status: next })

  async function togglePayload(ev) {
    if (openId === ev.id) { setOpenId(null); return }
    setOpenId(ev.id)
    if (payloads[ev.id] && payloads[ev.id] !== 'error') return
    setPayloads(p => ({ ...p, [ev.id]: 'loading' }))
    try {
      const res = await api.get(`/admin/webhook-events/${ev.id}`)
      setPayloads(p => ({ ...p, [ev.id]: res.data.data.payload || {} }))
    } catch (_) {
      setPayloads(p => ({ ...p, [ev.id]: 'error' }))
    }
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

      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="wh-status" className="text-sm font-medium text-gray-700">Status</label>
          <select id="wh-status" value={status} onChange={e => setStatus(e.target.value)}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm w-56">
            <option value="">All</option>
            <option value="ATTENTION">Needs attention</option>
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <form className="flex flex-wrap items-end gap-3" onSubmit={e => { e.preventDefault(); applyFilters({ reference: refDraft.trim(), type: typeDraft.trim() }) }}>
          <div className="flex flex-col gap-1">
            <label htmlFor="wh-ref" className="text-sm font-medium text-gray-700">Payment reference</label>
            <input id="wh-ref" value={refDraft} onChange={e => setRefDraft(e.target.value)} placeholder="contains…"
              className="rounded-md border border-gray-300 px-3 py-2 text-sm w-56 font-mono" />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="wh-type" className="text-sm font-medium text-gray-700">Event type</label>
            <input id="wh-type" value={typeDraft} onChange={e => setTypeDraft(e.target.value)} placeholder="e.g. refund.processed"
              className="rounded-md border border-gray-300 px-3 py-2 text-sm w-56 font-mono" />
          </div>
          <Button type="submit" size="sm" variant="secondary">Search</Button>
        </form>
      </div>

      <p className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-md px-3 py-2">
        HELD = an amount/currency mismatch was caught (use Payments → Recheck to accept it). FAILED = processing threw
        and Paystack was told to retry. IGNORED = an event this app doesn't act on, or a reference with no payment row.
        A stuck RECEIVED means the Worker died mid-event. FAILED and stuck events are re-driven automatically every hour
        (up to 8 tries, then you're emailed once); HELD ones wait for you. Replay re-runs the stored event through the same handlers a
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
                <Fragment key={ev.id}>
                <tr>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{formatDate(ev.receivedAt)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-700">{ev.eventType}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-500">{ev.reference || '—'}</td>
                  <td className="px-4 py-3">
                    <Badge variant={badgeVariant(ev.status)}>{ev.status}</Badge>
                    {ev.error && <div className="text-xs text-red-600 mt-0.5 max-w-xs break-words">{ev.error}</div>}
                    {ev.note && <div className="text-xs text-gray-500 mt-0.5 max-w-xs break-words">{ev.note}</div>}
                    {ev.replayedAt && <div className="text-xs text-gray-400 mt-0.5">replayed {formatDate(ev.replayedAt)}</div>}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-500">{ev.attempts}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button type="button" onClick={() => togglePayload(ev)}
                      className="text-xs text-blue-700 hover:text-blue-800 underline underline-offset-2 mr-3">
                      {openId === ev.id ? 'Hide payload' : 'Payload'}
                    </button>
                    {ev.replayable && (
                      <Button size="sm" variant="secondary" loading={busyId === ev.id} onClick={() => setPending(ev)}>
                        Replay
                      </Button>
                    )}
                  </td>
                </tr>
                {openId === ev.id && (
                  <tr>
                    <td colSpan={6} className="px-4 pb-4 bg-gray-50">
                      {payloads[ev.id] === 'loading' ? <Spinner /> :
                       payloads[ev.id] === 'error' ? <p className="text-xs text-red-600 py-2">Couldn't load the payload.</p> :
                       <pre className="text-xs text-gray-700 overflow-x-auto py-2">{JSON.stringify(payloads[ev.id], null, 2)}</pre>}
                      <p className="text-xs text-gray-400">Stored with card, customer and IP details removed.</p>
                    </td>
                  </tr>
                )}
                </Fragment>
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
