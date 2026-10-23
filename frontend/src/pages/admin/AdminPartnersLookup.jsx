import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import api from '../../lib/api'
import Button from '../../components/ui/Button'
import Badge from '../../components/ui/Badge'
import Spinner from '../../components/ui/Spinner'
import DataTable from '../../components/ui/DataTable'
import Input from '../../components/ui/Input'
import Checkbox from '../../components/ui/Checkbox'
import Select from '../../components/ui/Select'
import { useToast } from '../../components/ui/Toast'
import { formatCents, formatDate, downloadCsv, dateStamp, csvText } from '../../lib/utils'

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
  const [activeFilter, setActiveFilter] = useState('')   // '' | 'true' | 'false'
  const [personalOnly, setPersonalOnly] = useState(false)   // round 31: the controls for these two were never built (the state had no setter in the UI)
  useEffect(() => { const t = setTimeout(() => { setDebounced(q.trim()); setOffset(0) }, 300); return () => clearTimeout(t) }, [q])
  const { rows, total, loading, error } = usePagedFetch('/partners/codes', { q: debounced || undefined, active: activeFilter || undefined, ...(personalOnly ? { personal: 'true' } : {}), limit: PAGE, offset })
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end gap-4 flex-wrap">
        <Input size="sm" type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Find a referral code…" aria-label="Find a referral code"
          wrapperClassName="w-64" />
        <Select size="sm" aria-label="Code state" data-testid="code-state-filter" value={activeFilter} onChange={e => { setActiveFilter(e.target.value); setOffset(0) }}>
          <option value="">Active and inactive</option>
          <option value="true">Active only</option>
          <option value="false">Inactive only</option>
        </Select>
        <Checkbox label="Personal welcome codes only" checked={personalOnly} onChange={e => { setPersonalOnly(e.target.checked); setOffset(0) }} />
      </div>
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
                  {r.personal
                    ? <span className="text-gray-500" data-testid="personal-code">Personal welcome code</span>   /* the owner is a customer, not a partner: there is no partner page */
                    : <Link to={`/admin/partners/${r.partnerId}`} className="text-blue-600 hover:underline">{r.partnerName || 'Partner'}</Link>}
                  {!r.personal && <div className="text-xs text-gray-400">{r.partnerEmail}</div>}
                </>
              ),
            },
            {
              key: 'state',
              header: 'State',
              cell: r => (
                <>
                  {r.active ? <Badge variant="green">Active</Badge> : <Badge variant="gray">Inactive</Badge>}
                  {r.expiresAt && <span className="text-xs text-gray-400 ml-2">expires {formatDate(r.expiresAt, { utc: true })}</span>}
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
      downloadCsv(`payouts-${dateStamp()}.csv`, out)
      toast({ message: `Exported ${out.length - 1} payout(s).`, type: 'success' })
    } catch (_) { toast({ message: 'Export failed.', type: 'error' }) }
    finally { setExporting(false) }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4 flex-wrap text-sm">
        <Checkbox label="Show voided" checked={includeVoided} onChange={e => { setIncludeVoided(e.target.checked); setOffset(0) }} />
        <label className="flex items-center gap-2 text-gray-600">From
          <Input type="date" size="sm" wrapperClassName="w-40" value={from} max={to || undefined} onChange={e => { setFrom(e.target.value); setOffset(0) }} aria-label="Paid from" />
        </label>
        <label className="flex items-center gap-2 text-gray-600">To
          <Input type="date" size="sm" wrapperClassName="w-40" value={to} min={from || undefined} onChange={e => { setTo(e.target.value); setOffset(0) }} aria-label="Paid to" />
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
  const [state, setState] = useState({ rows: [], loading: true, error: false, checked: 0, truncated: false })
  const [busy, setBusy] = useState(null)
  const load = () => {
    setState(s => ({ ...s, loading: true, error: false }))
    api.get('/partners/unrecorded-commissions')
      .then(r => setState({ rows: r.data.data || [], checked: r.data.checked || 0, truncated: !!r.data.truncated, loading: false, error: false }))
      .catch(() => setState({ rows: [], checked: 0, truncated: false, loading: false, error: true }))
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
        Successful payments from the last 90 days that used a partner code and have no commission row (checked {state.checked}; payments under 15 minutes old, duplicates and payments with no deliverable scan are skipped).
        {state.truncated && ' Only the newest payments were checked — older ones are not covered by this list.'}
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

// Round 20 (feature gap): every sale, refund and adjustment across ALL partners in one file, for month-end reconciliation against
// Paystack and the books. Dates are UTC (cycles are UTC). A date-only "to" runs through the end of that day.
const LEDGER_PAGE = 200
const LEDGER_MAX_PAGES = 100   // 20,000 rows; the screen says when the file was cut short
function LedgerExport() {
  const toast = useToast()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  async function run() {
    setBusy(true); setNote('')
    try {
      const out = [['Date (UTC)', 'Partner', 'Email', 'Code', 'Type', 'Payment ref', 'Sale', 'Rate', 'Commission', 'Currency', 'Status', 'Paid on (UTC)', 'Reason', 'Channel tag']]
      let complete = false
      for (let page = 0; page < LEDGER_MAX_PAGES; page++) {
        const r = await api.get('/partners/ledger', { params: { limit: LEDGER_PAGE, offset: page * LEDGER_PAGE, ...(from ? { from } : {}), ...(to ? { to } : {}) } })
        for (const l of r.data.data) out.push([
          String(l.createdAt || '').slice(0, 10), l.partnerName || '', l.partnerEmail || '', l.code || '', l.type, csvText(l.paymentRef || ''),
          (l.grossAmountCents || 0) / 100, l.commissionRate == null ? '' : `${+(l.commissionRate * 100).toFixed(2)}%`,
          (l.commissionAmountCents || 0) / 100, l.currency || '', l.paid ? 'Paid' : 'Unpaid', String(l.paidAt || '').slice(0, 10), l.reason || '', l.sub || ''])
        if (r.data.data.length < LEDGER_PAGE) { complete = true; break }
      }
      downloadCsv(`commission-ledger-${dateStamp()}.csv`, out)
      if (!complete) setNote(`The file holds the newest ${(out.length - 1).toLocaleString('en-US')} entries — narrow the dates to get the rest.`)
      toast({ message: `Exported ${out.length - 1} ledger entr${out.length === 2 ? 'y' : 'ies'}.`, type: complete ? 'success' : 'warning' })
    } catch (_) { toast({ message: 'Export failed.', type: 'error' }) }
    finally { setBusy(false) }
  }
  return (
    <div className="flex flex-col gap-3" data-testid="ledger-export">
      <p className="text-xs text-gray-500">Every sale, refund reversal and manual adjustment for every partner, newest first. Dates are UTC.</p>
      <div className="flex items-end gap-4 flex-wrap text-sm">
        <Input type="date" size="sm" label="From" aria-label="Ledger from" wrapperClassName="w-fit" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} />
        <Input type="date" size="sm" label="To" aria-label="Ledger to" wrapperClassName="w-fit" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} />
        <Button size="sm" variant="secondary" loading={busy} onClick={run}>Export CSV</Button>
      </div>
      {note && <p role="status" className="text-xs text-amber-700" data-testid="ledger-truncated">{note}</p>}
    </div>
  )
}

export default function PartnersLookupPanel() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState('codes')
  if (!open) {
    return <button type="button" onClick={() => setOpen(true)} className="self-start text-xs text-gray-400 hover:text-gray-600">Find a code · Payout history · Commission ledger · Missing commissions →</button>
  }
  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-white flex flex-col gap-3" data-testid="partners-lookup">
      <div className="flex items-center gap-4 text-sm">
        {[['codes', 'Referral codes'], ['payouts', 'Payout history'], ['ledger', 'Commission ledger'], ['missing', 'Missing commissions']].map(([k, l]) => (
          <button key={k} type="button" onClick={() => setTab(k)}
            className={tab === k ? 'font-medium text-blue-700 underline underline-offset-4' : 'text-gray-500 hover:text-gray-700'}>{l}</button>
        ))}
        <button type="button" onClick={() => setOpen(false)} className="ml-auto text-xs text-gray-400 hover:text-gray-600">Close</button>
      </div>
      {tab === 'codes' ? <CodeLookup /> : tab === 'payouts' ? <PayoutsLog /> : tab === 'ledger' ? <LedgerExport /> : <UnrecordedCommissions />}
    </div>
  )
}
