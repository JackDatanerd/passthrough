import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import api from '../../lib/api'
import Button from '../../components/ui/Button'
import Badge from '../../components/ui/Badge'
import Spinner from '../../components/ui/Spinner'
import DataTable from '../../components/ui/DataTable'
import Input from '../../components/ui/Input'
import Checkbox from '../../components/ui/Checkbox'
import { useToast } from '../../components/ui/Toast'
import { formatCents, formatDate, downloadCsv } from '../../lib/utils'

// Cross-partner views (round 5). The partner list deliberately ships no codes or payout
// history (scale), which left "who owns code X?" and "what did we pay in September?" needing
// a click through every partner. Read-only, paged on the server.

const PAGE = 25

export function OverviewStrip() {
  const [o, setO] = useState(null)
  useEffect(() => {
    let alive = true
    api.get('/partners/overview').then(r => { if (alive) setO(r.data.data) }).catch(() => {})
    return () => { alive = false }
  }, [])
  if (!o) return null
  const cell = (label, value, hint) => (
    <div className="border border-gray-200 rounded-lg p-4 bg-white" key={label}>
      <div className="text-xs uppercase tracking-wide text-gray-400">{label}</div>
      <div className="text-xl font-bold text-gray-900">{value}</div>
      {hint && <div className="text-xs text-gray-400 mt-1">{hint}</div>}
    </div>
  )
  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4" data-testid="partners-overview">
      {cell('Owed to partners', formatCents(o.owedCents, o.currency), o.creditCents > 0 ? `Per partner; ${formatCents(o.creditCents, o.currency)} of refund credit is held against future sales` : 'Unpaid commission, summed per partner')}
      {cell('Paid out to date', formatCents(o.paidOutCents, o.currency), 'Voided payouts excluded')}
      {cell('Lifetime commission', formatCents(o.lifetimeCommissionCents, o.currency))}
      {cell('Applications waiting', o.pendingApplications, `${o.activePartners} active of ${o.partners} partners`)}
    </div>
  )
}

function Pager({ offset, total, count, onPage }) {
  if (total == null || total <= PAGE) return null
  return (
    <div className="flex items-center justify-between text-sm text-gray-500 pt-2">
      <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => onPage(Math.max(0, offset - PAGE))}>← Previous</Button>
      <span>{offset + 1}–{offset + count} of {total}</span>
      <Button size="sm" variant="secondary" disabled={offset + PAGE >= total} onClick={() => onPage(offset + PAGE)}>Next →</Button>
    </div>
  )
}

// Ignores a response that arrives after a newer request was sent (fast typing / tab flips).
function usePagedFetch(path, params) {
  const [state, setState] = useState({ rows: [], total: null, loading: true, error: false })
  const seq = useRef(0)
  const key = JSON.stringify(params)
  useEffect(() => {
    const mine = ++seq.current
    setState(s => ({ ...s, loading: true, error: false }))
    api.get(path, { params })
      .then(r => { if (mine === seq.current) setState({ rows: r.data.data, total: r.data.total, loading: false, error: false }) })
      .catch(() => { if (mine === seq.current) setState(s => ({ ...s, loading: false, error: true })) })
  }, [path, key]) // eslint-disable-line react-hooks/exhaustive-deps
  return state
}

function CodeLookup() {
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [offset, setOffset] = useState(0)
  const [activeFilter, setActiveFilter] = useState('')   // '' | 'true' | 'false' (round 10: the server always supported it)
  useEffect(() => { const t = setTimeout(() => { setDebounced(q.trim()); setOffset(0) }, 300); return () => clearTimeout(t) }, [q])
  const { rows, total, loading, error } = usePagedFetch('/partners/codes', { q: debounced || undefined, active: activeFilter || undefined, limit: PAGE, offset })
  return (
    <div className="flex flex-col gap-3">
      <Input size="sm" type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Find a referral code…" aria-label="Find a referral code"
        wrapperClassName="w-64" />
      {loading && <Spinner />}
      {error && <p className="text-sm text-red-600">Couldn't load codes.</p>}
      {!loading && !error && rows.length === 0 && <p className="text-sm text-gray-400">No codes match.</p>}
      {rows.length > 0 && (
        <DataTable
          caption="Referral codes"
          density="compact"
          columns={[
            {
              key: 'code',
              header: 'Code',
              cellClassName: 'font-mono text-gray-900',
              cell: r => r.code,
            },
            {
              key: 'partner',
              header: 'Partner',
              cell: r => (
                <>
                  <Link to={`/admin/partners/${r.partnerId}`} className="text-blue-600 hover:underline">{r.partnerName || 'Partner'}</Link>
                  <div className="text-xs text-gray-400">{r.partnerEmail}</div>
                </>
              ),
            },
            {
              key: 'state',
              header: 'State',
              cell: r => (
                <>
                  {r.active ? <Badge variant="green">Active</Badge> : <Badge variant="gray">Inactive</Badge>}
                  {r.expiresAt && <span className="text-xs text-gray-400 ml-2">expires {formatDate(r.expiresAt)}</span>}
                </>
              ),
            },
            {
              key: 'clicks',
              header: 'Clicks',
              headerClassName: 'text-right',
              cellClassName: 'text-right text-gray-600',
              cell: r => r.clicks ?? 0,
            },
            {
              key: 'uses',
              header: 'Uses',
              headerClassName: 'text-right',
              cellClassName: 'text-right text-gray-600',
              cell: r => (
                <>
                  {r.usesSoFar ?? 0}{r.usageLimit != null ? ` / ${r.usageLimit}` : ''}
                </>
              ),
            },
          ]}
          rows={rows}
          rowKey={r => r.id}
        />
      )}
      <Pager offset={offset} total={total} count={rows.length} onPage={setOffset} />
    </div>
  )
}

function PayoutsLog() {
  const toast = useToast()
  const [offset, setOffset] = useState(0)
  const [includeVoided, setIncludeVoided] = useState(false)
  const [exporting, setExporting] = useState(false)
  // Round 10: "what did we pay in September?" — the server filtered on from/to all along; the page never sent them. A bare
  // date is inclusive of the whole day (the server treats a date-only `to` as end of day).
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const range = { ...(from ? { from } : {}), ...(to ? { to } : {}) }
  const params = { limit: PAGE, offset, ...(includeVoided ? { includeVoided: 'true' } : {}), ...range }
  const { rows, total, loading, error } = usePagedFetch('/partners/payouts', params)

  async function exportAll() {
    setExporting(true)
    try {
      const out = [['Paid at', 'Partner', 'Email', 'Method', 'Amount', 'Currency', 'Commission settled', 'Period start', 'Period end', 'Status', 'Note', 'Internal note']]
      for (let page = 0; ; page += 200) {
        const r = await api.get('/partners/payouts', { params: { limit: 200, offset: page, ...(includeVoided ? { includeVoided: 'true' } : {}), ...range } })
        for (const p of r.data.data) out.push([
          p.paidAt || p.createdAt, p.partnerName || '', p.partnerEmail || '', p.payoutMethod || '',
          (p.amountCents || 0) / 100, p.currency, p.settledCommissionCents != null ? p.settledCommissionCents / 100 : '',
          p.periodStart || '', p.periodEnd || '', p.voidedAt ? 'VOIDED' : 'PAID', p.note || '', p.internalNote || ''])
        if (r.data.data.length < 200) break
      }
      downloadCsv(`payouts-${new Date().toISOString().slice(0, 10)}.csv`, out)
      toast({ message: `Exported ${out.length - 1} payout(s).`, type: 'success' })
    } catch (_) { toast({ message: 'Export failed.', type: 'error' }) }
    finally { setExporting(false) }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4 flex-wrap text-sm">
        <Checkbox label="Show voided" checked={includeVoided} onChange={e => { setIncludeVoided(e.target.checked); setOffset(0) }} />
        <label className="flex items-center gap-2 text-gray-600">From
          <input type="date" value={from} max={to || undefined} onChange={e => { setFrom(e.target.value); setOffset(0) }} aria-label="Paid from"
            className="text-sm border border-gray-300 rounded-md px-2 py-1" />
        </label>
        <label className="flex items-center gap-2 text-gray-600">To
          <input type="date" value={to} min={from || undefined} onChange={e => { setTo(e.target.value); setOffset(0) }} aria-label="Paid to"
            className="text-sm border border-gray-300 rounded-md px-2 py-1" />
        </label>
        {(from || to) && <button type="button" onClick={() => { setFrom(''); setTo(''); setOffset(0) }} className="text-xs text-gray-400 hover:text-gray-600">Clear dates</button>}
        <Button size="sm" variant="secondary" loading={exporting} onClick={exportAll}>Export CSV</Button>
      </div>
      {loading && <Spinner />}
      {error && <p className="text-sm text-red-600">Couldn't load payouts.</p>}
      {!loading && !error && rows.length === 0 && <p className="text-sm text-gray-400">No payouts recorded.</p>}
      {rows.length > 0 && (
        <DataTable
          caption="Partner payouts"
          density="compact"
          columns={[
            {
              key: 'paid',
              header: 'Paid',
              cell: p => formatDate(p.paidAt || p.createdAt),
            },
            {
              key: 'partner',
              header: 'Partner',
              cell: p => (
                <>
                  <Link to={`/admin/partners/${p.partnerId}`} className="text-blue-600 hover:underline">{p.partnerName || 'Partner'}</Link>
                </>
              ),
            },
            {
              key: 'amount',
              header: 'Amount',
              headerClassName: 'text-right',
              cellClassName: p => `text-right ${p.voidedAt ? 'line-through' : 'font-medium text-gray-900'}`,
              cell: p => (
                <>
                  {formatCents(p.amountCents, p.currency)}{p.voidedAt && <Badge variant="gray" className="ml-2">Voided</Badge>}
                </>
              ),
            },
            {
              key: 'method',
              header: 'Method',
              cell: p => p.payoutMethod === 'BANK' ? 'Bank' : 'Mobile money',
            },
          ]}
          rows={rows}
          rowKey={p => p.id}
          rowClassName={p => p.voidedAt ? 'bg-gray-50 text-gray-400' : ''}
        />
      )}
      <Pager offset={offset} total={total} count={rows.length} onPage={setOffset} />
    </div>
  )
}

// Round 18 (feature gap): paid sales that used a partner code but have no commission row. recordConversion failures are
// retried by the sweeps and announced by an alert; this is the place an admin can SEE what is still missing and retry it
// (the same reconcile call the payment screens use). Read-only until a row's Retry is pressed.
function UnrecordedCommissions() {
  const toast = useToast()
  const [state, setState] = useState({ rows: [], loading: true, error: false, checked: 0 })
  const [busy, setBusy] = useState(null)
  const load = () => {
    setState(s => ({ ...s, loading: true, error: false }))
    api.get('/partners/unrecorded-commissions')
      .then(r => setState({ rows: r.data.data || [], checked: r.data.checked || 0, loading: false, error: false }))
      .catch(() => setState({ rows: [], checked: 0, loading: false, error: true }))
  }
  useEffect(() => { load() }, [])
  async function retry(row) {
    setBusy(row.paymentId)
    try {
      await api.post(`/payments/${encodeURIComponent(row.reference)}/reconcile`)
      toast({ message: 'Retried. Reloading the list.', type: 'success' })
    } catch (err) {
      toast({ message: err?.response?.data?.message || 'The retry failed. Try again in a moment.', type: 'error' })
    } finally { setBusy(null); load() }
  }
  if (state.loading) return <Spinner />
  if (state.error) return <p className="text-sm text-red-600">Could not load. <button type="button" className="underline" onClick={load}>Try again</button></p>
  return (
    <div className="flex flex-col gap-2" data-testid="unrecorded-commissions">
      <p className="text-xs text-gray-500">
        Successful payments from the last 90 days that used a partner code and have no commission row (checked {state.checked}; payments under 15 minutes old are skipped).
      </p>
      {state.rows.length === 0
        ? <p className="text-sm text-gray-500">Nothing missing.</p>
        : (
          <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
            {state.rows.map(r => (
              <li key={r.paymentId} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-mono text-xs text-gray-500">{r.reference}</span>
                  <span className="block text-gray-700">{r.partnerName || 'Unknown partner'} · {r.code || '—'} · {formatCents(r.amountCents, r.currency)} · {formatDate(r.paidAt)}</span>
                </span>
                <Button size="sm" variant="secondary" loading={busy === r.paymentId} onClick={() => retry(r)}>Retry</Button>
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}

export default function PartnersLookupPanel() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState('codes')
  if (!open) {
    return <button type="button" onClick={() => setOpen(true)} className="self-start text-xs text-gray-400 hover:text-gray-600">Find a code · Payout history · Missing commissions →</button>
  }
  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-white flex flex-col gap-3" data-testid="partners-lookup">
      <div className="flex items-center gap-4 text-sm">
        {[['codes', 'Referral codes'], ['payouts', 'Payout history'], ['missing', 'Missing commissions']].map(([k, l]) => (
          <button key={k} type="button" onClick={() => setTab(k)}
            className={tab === k ? 'font-medium text-blue-700 underline underline-offset-4' : 'text-gray-500 hover:text-gray-700'}>{l}</button>
        ))}
        <button type="button" onClick={() => setOpen(false)} className="ml-auto text-xs text-gray-400 hover:text-gray-600">Close</button>
      </div>
      {tab === 'codes' ? <CodeLookup /> : tab === 'payouts' ? <PayoutsLog /> : <UnrecordedCommissions />}
    </div>
  )
}
