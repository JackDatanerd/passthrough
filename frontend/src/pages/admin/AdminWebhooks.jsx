import { useState, useEffect, useCallback } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import api, { getErrorMessage } from '../../lib/api'
import Button from '../../components/ui/Button'
import Badge from '../../components/ui/Badge'
import Spinner from '../../components/ui/Spinner'
import DataTable from '../../components/ui/DataTable'
import Pagination from '../../components/ui/Pagination'
import Input from '../../components/ui/Input'
import Select from '../../components/ui/Select'
import Checkbox from '../../components/ui/Checkbox'
import ConfirmDialog from '../../components/ui/ConfirmDialog'
import { useToast } from '../../components/ui/Toast'
import { formatDate } from '../../lib/utils'
import usePageClamp from '../../hooks/usePageClamp'
import EmptyState from '../../components/ui/EmptyState'
import useLatestRequest from '../../hooks/useLatestRequest'

// SECTION 8 AUDIT (feature gap): webhook_events is the durable inbox every
// verified Paystack event lands in — an audit trail and the dedupe record — but
// nothing in the app could show it, and every alert said "check webhook_events".
// This is that view, plus a replay for events that were HELD / FAILED / IGNORED
// (the inbox treats those as finished, so neither Paystack's own "Resend" nor a
// redelivery could ever re-run them).

// ROUND 7 (feature gap): Resend bounce / complaint / failure events are in the same inbox now (provider 'resend'),
// deduped, re-driven and replayable like Paystack's.
const PAGE_SIZE = 25
const PROVIDERS = [['paystack', 'Paystack'], ['resend', 'Resend']]
const STATUSES = ['RECEIVED', 'PROCESSED', 'IGNORED', 'HELD', 'FAILED']
// ATTENTION = FAILED + HELD + RECEIVED for over 15 minutes (the Worker died mid-event): what needs a person.
const badgeVariant = s => ({ PROCESSED: 'green', RECEIVED: 'amber', IGNORED: 'gray', HELD: 'amber', FAILED: 'red' }[s] || 'gray')

export default function AdminWebhooks() {
  const toast = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  const status = searchParams.get('status') || ''
  const referenceQ = searchParams.get('reference') || ''
  const typeQ = searchParams.get('type') || ''
  const providerQ = PROVIDERS.some(([v]) => v === searchParams.get('provider')) ? searchParams.get('provider') : ''
  // ROUND 11 (G5): received-date window (YYYY-MM-DD), kept in the URL like the other filters.
  const dayParam = k => {
    const v = searchParams.get(k) || ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return ''
    const d = new Date(`${v}T00:00:00Z`)
    return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? '' : v   // 2026-99-99 / 2026-02-31 are not days
  }
  const fromQ = dayParam('from')
  const toQ = dayParam('to')
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
  // ROUND 11 (G2): close out a FAILED / HELD / stuck row that can never succeed.
  const [dismissing, setDismissing] = useState(null)
  const [dismissNote, setDismissNote] = useState('')
  // ROUND 5 (feature gap): are webhooks reaching this app at all? See webhooks.controller computeWebhookHealth.
  const [health, setHealth] = useState(null)
  // ROUND 13 (G4): tick several rows, then Replay or Dismiss them in one go. Each row is its own request to the existing endpoints (a replay
  // runs the full handler, so batching them in ONE Worker invocation would share one subrequest budget); the run stops at the first failure.
  const [selected, setSelected] = useState(() => new Set())
  const [bulk, setBulk] = useState(null)            // 'replay' | 'dismiss' awaiting confirmation
  const [bulkNote, setBulkNote] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)

  // Round 18 (G2): check the setup (secrets, IP list, migrations, Paystack key) without waiting for a real delivery to fail.
  const [selfTest, setSelfTest] = useState(null)   // { loading, data, error } | null
  async function runSelfTest() {
    setSelfTest({ loading: true, data: null, error: '' })
    try { setSelfTest({ loading: false, data: (await api.get('/admin/webhook-events/self-test')).data.data, error: '' }) }
    catch (err) { setSelfTest({ loading: false, data: null, error: getErrorMessage(err, 'The self-test could not be run.') }) }
  }

  const loadHealth = useCallback(async () => {
    try { setHealth((await api.get('/admin/webhook-events/health')).data.data) }
    catch (_) { setHealth(null) }
  }, [])
  useEffect(() => { loadHealth() }, [loadHealth])

  // ROUND 5 (bug): the two search boxes were seeded from the URL once and never again, so browser
  // back/forward changed the results but left the previous search text in the inputs. Keep them
  // in step with the URL, and start from page 1 whenever the filters change.
  useEffect(() => { setRefDraft(referenceQ); setTypeDraft(typeQ) }, [referenceQ, typeQ])
  useEffect(() => { setPage(1) }, [status, referenceQ, typeQ, providerQ, fromQ, toQ])
  // A selection belongs to the rows on screen: a new page, filter or reload drops ids that are no longer listed.
  useEffect(() => { setSelected(prev => { const ids = new Set(events.map(e => e.id)); const next = new Set([...prev].filter(id => ids.has(id))); return next.size === prev.size ? prev : next }) }, [events])

  const begin = useLatestRequest()

  const load = useCallback(async () => {
    const isCurrent = begin()
    setLoading(true)
    try {
      const res = await api.get('/admin/webhook-events', { signal: isCurrent.signal, params: { page, pageSize: PAGE_SIZE, status: status || undefined, reference: referenceQ || undefined, type: typeQ || undefined, provider: providerQ || undefined, from: fromQ || undefined, to: toQ || undefined } })
      if (!isCurrent()) return
      setEvents(res.data.data)
      setTotal(res.data.meta.total)
    } catch (err) {
      if (!isCurrent()) return
      toast({ message: getErrorMessage(err, 'Failed to load webhook events.'), type: 'error' })
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [page, status, referenceQ, typeQ, providerQ, fromQ, toQ])

  useEffect(() => { load() }, [load])

  function applyFilters(next = {}) {
    const merged = { status, reference: referenceQ, type: typeQ, provider: providerQ, from: fromQ, to: toQ, ...next }
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
      setPayloads(p => ({ ...p, [ev.id]: res.data.data.payload || 'none' }))
    } catch (_) {
      setPayloads(p => ({ ...p, [ev.id]: 'error' }))
    }
  }

  async function runReplay(ev) {
    setBusyId(ev.id)
    try {
      const res = await api.post(`/admin/webhook-events/${ev.id}/replay`)
      const d = res.data.data || {}
      // ROUND 11 (G5): only PROCESSED did work. IGNORED (payment still missing…) is not a success.
      toast({ message: `Replayed → ${d.status}${d.note ? ` (${d.note})` : ''}${d.hint ? `. ${d.hint}` : ''}`, type: d.status === 'PROCESSED' ? 'success' : d.status === 'HELD' ? 'error' : 'info' })
      load(); loadHealth()
    } catch (err) {
      toast({ message: getErrorMessage(err, 'Replay failed.'), type: 'error' })
    } finally {
      setBusyId(null)
      setPending(null)
    }
  }

  async function runDismiss(ev) {
    setBusyId(ev.id)
    try {
      await api.post(`/admin/webhook-events/${ev.id}/dismiss`, { note: dismissNote.trim() || undefined })
      toast({ message: 'Event dismissed.', type: 'success' })
      load(); loadHealth()
    } catch (err) {
      toast({ message: getErrorMessage(err, 'Dismiss failed.'), type: 'error' })
    } finally {
      setBusyId(null)
      setDismissing(null)
      setDismissNote('')
    }
  }

  const selectedEvents = events.filter(e => selected.has(e.id))
  const canReplay = selectedEvents.filter(e => e.replayable)
  const canDismiss = selectedEvents.filter(e => e.dismissable)
  const pageSelectable = events.filter(e => e.replayable || e.dismissable)
  const selectedOnPage = pageSelectable.filter(e => selected.has(e.id)).length
  const allTicked = pageSelectable.length > 0 && pageSelectable.every(e => selected.has(e.id))
  const toggleOne = id => setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const toggleAll = () => setSelected(allTicked ? new Set() : new Set(pageSelectable.map(e => e.id)))

  async function runBulk(kind) {
    const rows = kind === 'replay' ? canReplay : canDismiss
    setBulkBusy(true)
    const tally = { PROCESSED: 0, IGNORED: 0, HELD: 0, FAILED: 0, dismissed: 0 }
    let done = 0, stopped = null
    for (const ev of rows) {
      try {
        if (kind === 'replay') {
          const d = (await api.post(`/admin/webhook-events/${ev.id}/replay`)).data.data || {}
          tally[d.status] = (tally[d.status] || 0) + 1
        } else {
          await api.post(`/admin/webhook-events/${ev.id}/dismiss`, { note: bulkNote.trim() || undefined })
          tally.dismissed += 1
        }
        done += 1
      } catch (err) {
        stopped = getErrorMessage(err, `${kind === 'replay' ? 'Replay' : 'Dismiss'} failed.`)
        break
      }
    }
    const parts = kind === 'replay'
      ? ['PROCESSED', 'IGNORED', 'HELD', 'FAILED'].filter(k => tally[k]).map(k => `${tally[k]} ${k.toLowerCase()}`)
      : [`${tally.dismissed} dismissed`]
    toast({
      message: `${kind === 'replay' ? 'Replayed' : 'Dismissed'} ${done} of ${rows.length}${parts.length && kind === 'replay' ? ` (${parts.join(', ')})` : ''}${stopped ? `. Stopped: ${stopped}` : ''}`,
      type: stopped ? 'error' : tally.HELD || tally.FAILED ? 'info' : 'success',
    })
    setBulkBusy(false); setBulk(null); setBulkNote(''); setSelected(new Set())
    load(); loadHealth()
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))


  usePageClamp({ page, total, pageSize: PAGE_SIZE, setPage, loading })
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-gray-900">Webhook events</h1>

      <div className="flex flex-wrap items-end gap-4">
        <Select id="wh-status" label="Status" value={status} onChange={e => setStatus(e.target.value)} wrapperClassName="w-56">
          <option value="">All</option>
          <option value="ATTENTION">Needs attention</option>
          {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </Select>
        <Select id="wh-provider" label="Source" value={providerQ} onChange={e => applyFilters({ provider: e.target.value })} wrapperClassName="w-40">
          <option value="">All</option>
          {PROVIDERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
        <form className="flex flex-wrap items-end gap-3" onSubmit={e => { e.preventDefault(); applyFilters({ reference: refDraft.trim(), type: typeDraft.trim() }) }}>
          <Input id="wh-ref" label="Payment reference" value={refDraft} onChange={e => setRefDraft(e.target.value)}
            placeholder="contains…" wrapperClassName="w-56" className="font-mono" />
          <Input id="wh-type" label="Event type" value={typeDraft} onChange={e => setTypeDraft(e.target.value)}
            placeholder="e.g. refund.processed" wrapperClassName="w-56" className="font-mono" />
          <Input id="wh-from" label="From" type="date" value={fromQ} onChange={e => applyFilters({ from: e.target.value })} wrapperClassName="w-40" />
          <Input id="wh-to" label="To" type="date" value={toQ} onChange={e => applyFilters({ to: e.target.value })} wrapperClassName="w-40" />
          <Button type="submit" size="sm" variant="secondary">Search</Button>
        </form>
      </div>

      {/* Webhooks round 17 (G1): deliveries that REACH the app but are refused (wrong/rotated signing key, source IP not allowed) used to
          leave no trace here. Shown only when the newest refusal is newer than the last delivery that got through. */}
      {health?.rejectedSinceLastEvent?.length > 0 && (
        <div role="alert" className="text-sm text-red-800 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {health.rejectedSinceLastEvent.map(provider => {
            const r = health.lastRejected?.[provider]
            const why = r?.reason === 'ip' ? 'its source IP is not in the allow-list (PAYSTACK_WEBHOOK_IPS)'
              : r?.reason === 'not-configured' ? 'the signing secret is not configured on the Worker'
              : 'the signature did not verify — the signing key here does not match the one in the dashboard (or someone is probing the endpoint with a made-up signature; a real delivery clears this)'
            return (
              <div key={provider}>
                <strong>{provider === 'resend' ? 'Resend' : 'Paystack'} deliveries are being refused</strong>
                {' '}(latest {r?.at ? formatDate(r.at) : 'recently'}): {why}. Nothing has got through since.
              </div>
            )
          })}
        </div>
      )}

      {health && health.available && (
        <div className={(health.unrecovered ?? health.paidWithoutEvent) > 0 ? 'text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2' : 'text-xs text-gray-500'}>
          {(health.unrecovered ?? health.paidWithoutEvent) > 0 ? (
            <>
              <strong>{health.unrecovered ?? health.paidWithoutEvent} paid sale{(health.unrecovered ?? health.paidWithoutEvent) === 1 ? '' : 's'} in the last 7 days {(health.unrecovered ?? health.paidWithoutEvent) === 1 ? 'has' : 'have'} no charge.success event on record and {(health.unrecovered ?? health.paidWithoutEvent) === 1 ? 'is' : 'are'} newer than the last one received</strong>
              {' '}(of {health.paidChecked} checked). They were settled by the buyer's return visit or the hourly sweeps, so Paystack may not be
              reaching this app: check the webhook URL and signing key in the Paystack dashboard.
              {(health.unrecoveredReferences || health.missingReferences)?.length > 0 && <> e.g. <span className="font-mono text-xs">{(health.unrecoveredReferences || health.missingReferences).join(', ')}</span></>}
              {' '}
            </>
          ) : null}
          Last event received {health.lastEventAt ? formatDate(health.lastEventAt) : 'never'}
          {' · '}last charge.success {health.lastChargeSuccessAt ? formatDate(health.lastChargeSuccessAt) : 'never'}.
          {/* ROUND 6 (feature gap): is the Resend endpoint reaching this app at all? Bounces and spam complaints are
              what is lost when it is not, and nothing else would say so. */}
          {' · '}last Resend event {health.lastResendEventAt ? formatDate(health.lastResendEventAt) : 'never'}
          {(!health.lastResendEventAt || Date.now() - Date.parse(health.lastResendEventAt) > 7 * 24 * 3600 * 1000) && (
            <span className="text-amber-700"> (with delivery events subscribed this means Resend is not reaching this app — check the endpoint URL and signing secret in Resend)</span>
          )}.
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div>
          <Button size="sm" variant="secondary" loading={!!selfTest?.loading} onClick={runSelfTest}>Check webhook setup</Button>
          <span className="text-xs text-gray-500 ml-3">Checks the signing secrets, IP allow-list, migrations and Paystack key. Sends nothing to the inbox.</span>
        </div>
        {selfTest?.error && <p role="alert" className="text-sm text-red-600">{selfTest.error}</p>}
        {selfTest?.data && (
          <div className="text-sm border border-gray-200 rounded-md px-3 py-2" aria-label="Webhook setup check">
            <ul className="flex flex-col gap-1">
              {selfTest.data.checks.map(ck => (
                <li key={ck.id} className="flex flex-wrap items-baseline gap-2">
                  <Badge variant={ck.status === 'ok' ? 'green' : ck.status === 'warn' ? 'amber' : 'red'}>{ck.status === 'ok' ? 'OK' : ck.status === 'warn' ? 'CHECK' : 'FIX'}</Badge>
                  <span className="font-medium text-gray-800">{ck.label}</span>
                  <span className="text-xs text-gray-600">{ck.detail}</span>
                </li>
              ))}
            </ul>
            {(selfTest.data.endpoints?.paystack || selfTest.data.endpoints?.resend) && (
              <p className="text-xs text-gray-500 mt-2">
                URLs to register — Paystack: <span className="font-mono">{selfTest.data.endpoints.paystack}</span>
                {' · '}Resend: <span className="font-mono">{selfTest.data.endpoints.resend}</span>
              </p>
            )}
          </div>
        )}
      </div>

      <p className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-md px-3 py-2">
        HELD = an amount/currency mismatch was caught (use Payments → Recheck to accept it). FAILED = processing threw
        and Paystack was told to retry. IGNORED = an event this app doesn't act on, or a reference with no payment row. Resend rows are bounce / complaint /
        delivery-failure events (a failed one means the address was NOT suppressed yet).
        A stuck RECEIVED means the Worker died mid-event. FAILED and stuck events are re-driven automatically every hour
        (8 automatic re-runs, then you're emailed once; Paystack's own redeliveries are counted separately); HELD ones wait for you. Dismiss closes a FAILED / HELD / stuck row that can never succeed (it stays visible as IGNORED, with your note). Replay re-runs the stored event through the same handlers a
        live delivery uses; it is safe to repeat.
      </p>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 text-sm bg-blue-50 border border-blue-200 rounded-md px-3 py-2" role="region" aria-label="Bulk actions">
          <span className="text-blue-900">{selected.size} selected</span>
          <Button size="sm" variant="secondary" disabled={canReplay.length === 0 || bulkBusy} onClick={() => setBulk('replay')}>Replay {canReplay.length}</Button>
          <Button size="sm" variant="ghost" disabled={canDismiss.length === 0 || bulkBusy} onClick={() => { setBulkNote(''); setBulk('dismiss') }}>Dismiss {canDismiss.length}</Button>
          <button type="button" className="text-xs underline text-blue-800" disabled={bulkBusy} onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : events.length === 0 ? (
        <EmptyState>No events found.</EmptyState>
      ) : (
        <DataTable
          caption="Webhook events"
          columns={[
            {
              key: 'select',
              header: (
                <Checkbox aria-label="Select every event on this page that can be replayed or dismissed"
                  checked={allTicked} indeterminate={!allTicked && selectedOnPage > 0} disabled={pageSelectable.length === 0 || bulkBusy} onChange={toggleAll} />
              ),
              cell: ev => (ev.replayable || ev.dismissable)
                ? <Checkbox aria-label={`Select ${ev.eventType}${ev.reference ? ` ${ev.reference}` : ''}`} checked={selected.has(ev.id)} disabled={bulkBusy} onChange={() => toggleOne(ev.id)} />
                : null,
            },
            {
              key: 'received',
              header: 'Received',
              cellClassName: 'text-gray-500 whitespace-nowrap',
              cell: ev => formatDate(ev.receivedAt),
            },
            {
              key: 'event',
              header: 'Event',
              cellClassName: 'font-mono text-xs text-gray-700',
              cell: ev => (
                <>
                  {ev.eventType}
                  {ev.provider && ev.provider !== 'paystack' && <div className="text-gray-400 mt-0.5">{ev.provider}</div>}
                </>
              ),
            },
            {
              key: 'reference',
              header: 'Reference',
              cellClassName: 'font-mono text-xs text-gray-500',
              cell: ev => (
                <>
                  {ev.reference
                    ? <Link to={`/admin/payments?reference=${encodeURIComponent(ev.reference)}`} className="text-blue-700 hover:underline" title="Open this payment">{ev.reference}</Link>
                    : '—'}
                </>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              cell: ev => (
                <>
                  <Badge variant={badgeVariant(ev.status)}>{ev.status}</Badge>
                  {ev.error && <div role="alert" className="text-xs text-red-600 mt-0.5 max-w-xs break-words">{ev.error}</div>}
                  {ev.note && <div className="text-xs text-gray-500 mt-0.5 max-w-xs break-words">{ev.note}</div>}
                  {ev.replayedAt && <div className="text-xs text-gray-400 mt-0.5">replayed {formatDate(ev.replayedAt)}</div>}
                </>
              ),
            },
            {
              key: 'tries',
              header: 'Tries',
              headerClassName: 'text-right',
              cellClassName: 'text-right text-gray-500',
              cell: ev => ev.attempts,
            },
            {
              key: 'duration',
              header: 'Took',
              headerClassName: 'text-right',
              cellClassName: 'text-right text-gray-500 whitespace-nowrap',
              // Webhooks round 14 (G3): Paystack redelivers a webhook that takes too long to answer (the work is done before the 200).
              cell: ev => ev.processingMs == null ? '—'
                : <span className={ev.processingMs >= 20000 ? 'text-red-600 font-medium' : ''}>{ev.processingMs >= 1000 ? `${(ev.processingMs / 1000).toFixed(1)} s` : `${ev.processingMs} ms`}</span>,
            },
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              cellClassName: 'text-right whitespace-nowrap',
              cell: ev => (
                <>
                  <button type="button" onClick={() => togglePayload(ev)}
                    className="text-xs text-blue-700 hover:text-blue-800 underline underline-offset-2 mr-3">
                    {openId === ev.id ? 'Hide payload' : 'Payload'}
                  </button>
                  {ev.replayable && (
                    <Button size="sm" variant="secondary" loading={busyId === ev.id} onClick={() => setPending(ev)}>
                      Replay
                    </Button>
                  )}
                  {ev.dismissable && (
                    <Button size="sm" variant="ghost" className="ml-2" disabled={busyId === ev.id} onClick={() => { setDismissNote(''); setDismissing(ev) }}>
                      Dismiss
                    </Button>
                  )}
                </>
              ),
            },
          ]}
          rows={events}
          rowKey={ev => ev.id}
          expandedRow={ev => openId === ev.id && (
            <>
              {payloads[ev.id] === 'loading' ? <Spinner /> :
               payloads[ev.id] === 'error' ? <p className="text-xs text-red-600 py-2">Couldn't load the payload.</p> :
               payloads[ev.id] === 'none' ? <p className="text-xs text-gray-500 py-2">No payload is stored for this event (it was cleared once finished, or this event type keeps none).</p> :
               <pre className="text-xs text-gray-700 overflow-x-auto py-2">{JSON.stringify(payloads[ev.id], null, 2)}</pre>}
              <p className="text-xs text-gray-400">Stored minimised: card, customer and IP details removed (Resend events keep only the recipient, bounce type and id).</p>
            </>
          )}
        />
      )}

      {totalPages > 1 && <Pagination page={page} totalPages={totalPages} onChange={p => setPage(p)} />}

      <ConfirmDialog
        open={!!dismissing}
        title="Dismiss this event?"
        message={dismissing ? `Close ${dismissing.eventType}${dismissing.reference ? ` (${dismissing.reference})` : ''} as IGNORED. It stops counting as needing attention and stops being re-driven and emailed about. Nothing is re-run. Use this only for an event that can never succeed or that you have already dealt with by hand.` : ''}
        confirmLabel="Dismiss"
        danger
        loading={!!dismissing && busyId === dismissing.id}
        onConfirm={() => runDismiss(dismissing)}
        onCancel={() => { setDismissing(null); setDismissNote('') }}
      >
        <Input id="wh-dismiss-note" label="Note (optional)" value={dismissNote} maxLength={200} onChange={e => setDismissNote(e.target.value)}
          placeholder="e.g. refunded in the Paystack dashboard" />
      </ConfirmDialog>

      <ConfirmDialog
        open={bulk === 'replay'}
        title={`Replay ${canReplay.length} event${canReplay.length === 1 ? '' : 's'}?`}
        message="Each selected event is re-run through the webhook handlers one after another (every handler is idempotent). It stops at the first request that fails."
        danger={false}
        loading={bulkBusy}
        onConfirm={() => runBulk('replay')}
        onCancel={() => setBulk(null)}
      />
      <ConfirmDialog
        open={bulk === 'dismiss'}
        title={`Dismiss ${canDismiss.length} event${canDismiss.length === 1 ? '' : 's'}?`}
        message="Close each selected event as IGNORED. They stop counting as needing attention and stop being re-driven and emailed about. Nothing is re-run. Use this only for events that can never succeed or that you have already dealt with by hand."
        confirmLabel="Dismiss"
        danger
        loading={bulkBusy}
        onConfirm={() => runBulk('dismiss')}
        onCancel={() => { setBulk(null); setBulkNote('') }}
      >
        <Input id="wh-bulk-note" label="Note (optional, applied to each)" value={bulkNote} maxLength={200} onChange={e => setBulkNote(e.target.value)}
          placeholder="e.g. refunded in the Paystack dashboard" />
      </ConfirmDialog>

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
