import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import api from '../../lib/api'
import Button from '../../components/ui/Button'
import Badge from '../../components/ui/Badge'
import Spinner from '../../components/ui/Spinner'
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
      {cell('Owed to partners', formatCents(o.owedCents, o.currency), 'Unpaid commission, net of refund credits')}
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
  useEffect(() => { const t = setTimeout(() => { setDebounced(q.trim()); setOffset(0) }, 300); return () => clearTimeout(t) }, [q])
  const { rows, total, loading, error } = usePagedFetch('/partners/codes', { q: debounced || undefined, limit: PAGE, offset })
  return (
    <div className="flex flex-col gap-3">
      <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Find a referral code…" aria-label="Find a referral code"
        className="text-sm border border-gray-300 rounded-md px-3 py-1.5 w-64 focus:outline-none focus:ring-2 focus:ring-blue-500" />
      {loading && <Spinner />}
      {error && <p className="text-sm text-red-600">Couldn't load codes.</p>}
      {!loading && !error && rows.length === 0 && <p className="text-sm text-gray-400">No codes match.</p>}
      {rows.length > 0 && (
        <div className="overflow-x-auto border border-gray-200 rounded-lg bg-white">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200">
              <th className="px-3 py-2">Code</th><th className="px-3 py-2">Partner</th><th className="px-3 py-2">State</th>
              <th className="px-3 py-2 text-right">Clicks</th><th className="px-3 py-2 text-right">Uses</th>
            </tr></thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map(r => (
                <tr key={r.id}>
                  <td className="px-3 py-2 font-mono text-gray-900">{r.code}</td>
                  <td className="px-3 py-2"><Link to={`/admin/partners/${r.partnerId}`} className="text-blue-600 hover:underline">{r.partnerName || 'Partner'}</Link>
                    <div className="text-xs text-gray-400">{r.partnerEmail}</div></td>
                  <td className="px-3 py-2">
                    {r.active ? <Badge variant="green">Active</Badge> : <Badge variant="gray">Inactive</Badge>}
                    {r.expiresAt && <span className="text-xs text-gray-400 ml-2">expires {formatDate(r.expiresAt)}</span>}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-600">{r.clicks ?? 0}</td>
                  <td className="px-3 py-2 text-right text-gray-600">{r.usesSoFar ?? 0}{r.usageLimit != null ? ` / ${r.usageLimit}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
  const params = { limit: PAGE, offset, ...(includeVoided ? { includeVoided: 'true' } : {}) }
  const { rows, total, loading, error } = usePagedFetch('/partners/payouts', params)

  async function exportAll() {
    setExporting(true)
    try {
      const out = [['Paid at', 'Partner', 'Email', 'Method', 'Amount', 'Currency', 'Commission settled', 'Period start', 'Period end', 'Status', 'Note', 'Internal note']]
      for (let from = 0; ; from += 200) {
        const r = await api.get('/partners/payouts', { params: { limit: 200, offset: from, ...(includeVoided ? { includeVoided: 'true' } : {}) } })
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
        <label className="flex items-center gap-2 text-gray-600">
          <input type="checkbox" checked={includeVoided} onChange={e => { setIncludeVoided(e.target.checked); setOffset(0) }} /> Show voided
        </label>
        <Button size="sm" variant="secondary" loading={exporting} onClick={exportAll}>Export CSV</Button>
      </div>
      {loading && <Spinner />}
      {error && <p className="text-sm text-red-600">Couldn't load payouts.</p>}
      {!loading && !error && rows.length === 0 && <p className="text-sm text-gray-400">No payouts recorded.</p>}
      {rows.length > 0 && (
        <div className="overflow-x-auto border border-gray-200 rounded-lg bg-white">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200">
              <th className="px-3 py-2">Paid</th><th className="px-3 py-2">Partner</th><th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2">Method</th>
            </tr></thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map(p => (
                <tr key={p.id} className={p.voidedAt ? 'bg-gray-50 text-gray-400' : ''}>
                  <td className="px-3 py-2">{formatDate(p.paidAt || p.createdAt)}</td>
                  <td className="px-3 py-2"><Link to={`/admin/partners/${p.partnerId}`} className="text-blue-600 hover:underline">{p.partnerName || 'Partner'}</Link></td>
                  <td className={`px-3 py-2 text-right ${p.voidedAt ? 'line-through' : 'font-medium text-gray-900'}`}>
                    {formatCents(p.amountCents, p.currency)}{p.voidedAt && <Badge variant="gray" className="ml-2">Voided</Badge>}
                  </td>
                  <td className="px-3 py-2">{p.payoutMethod === 'BANK' ? 'Bank' : 'Mobile money'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager offset={offset} total={total} count={rows.length} onPage={setOffset} />
    </div>
  )
}

export default function PartnersLookupPanel() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState('codes')
  if (!open) {
    return <button type="button" onClick={() => setOpen(true)} className="self-start text-xs text-gray-400 hover:text-gray-600">Find a code · Payout history →</button>
  }
  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-white flex flex-col gap-3" data-testid="partners-lookup">
      <div className="flex items-center gap-4 text-sm">
        {[['codes', 'Referral codes'], ['payouts', 'Payout history']].map(([k, l]) => (
          <button key={k} type="button" onClick={() => setTab(k)}
            className={tab === k ? 'font-medium text-blue-700 underline underline-offset-4' : 'text-gray-500 hover:text-gray-700'}>{l}</button>
        ))}
        <button type="button" onClick={() => setOpen(false)} className="ml-auto text-xs text-gray-400 hover:text-gray-600">Close</button>
      </div>
      {tab === 'codes' ? <CodeLookup /> : <PayoutsLog />}
    </div>
  )
}
