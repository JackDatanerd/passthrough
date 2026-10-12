import { useState, useEffect, useCallback } from 'react'
import api from '../../lib/api'
import Spinner from '../../components/ui/Spinner'
import DataTable from '../../components/ui/DataTable'
import Select from '../../components/ui/Select'
import { useToast } from '../../components/ui/Toast'
import useLatestRequest from '../../hooks/useLatestRequest'

// DATABASE AUDIT (feature gap): the Claude cost ledger (claude_usage, migration 0072) was written on every call
// and read by nothing. This is the read side: tokens per day and per kind of call, and — only when the owner
// has set CLAUDE_USD_PER_MTOK_INPUT / _OUTPUT — an estimated spend. The ledger is purged after 400 days.
const WINDOWS = [7, 30, 90, 365]
const fmt = n => (n == null ? '—' : Number(n).toLocaleString())
const usd = n => (n == null ? '—' : `$${Number(n).toFixed(2)}`)

const NUM_COLS = [
  { key: 'calls', header: 'Calls', className: 'text-right', cell: r => fmt(r.calls) },
  { key: 'in', header: 'Input', className: 'text-right', cell: r => fmt(r.inputTokens) },
  { key: 'out', header: 'Output', className: 'text-right', cell: r => fmt(r.outputTokens) },
  { key: 'usd', header: 'Est. $', className: 'text-right', cell: r => usd(r.estimatedUsd) },
]

function Tile({ label, value, hint }) {
  return (
    <div className="border border-gray-200 rounded-lg bg-white p-3">
      <div className="text-xs text-gray-400">{label}</div>
      <div className="text-xl font-semibold text-gray-900">{value}</div>
      {hint && <div className="text-xs text-gray-400">{hint}</div>}
    </div>
  )
}

export default function AdminClaudeUsage() {
  const toast = useToast()
  const [days, setDays] = useState(30)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [notReady, setNotReady] = useState(false)
  const begin = useLatestRequest()

  const load = useCallback(async () => {
    const isCurrent = begin()
    setLoading(true)
    setNotReady(false)
    try {
      const res = await api.get('/admin/claude-usage', { params: { days } })
      if (!isCurrent()) return
      setData(res.data.data)
    } catch (err) {
      if (!isCurrent()) return
      if (err?.response?.status === 503) setNotReady(true)
      else toast({ message: 'Failed to load Claude usage.', type: 'error' })
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [days])

  useEffect(() => { load() }, [load])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Claude usage</h1>
        <Select aria-label="Time window" size="sm" wrapperClassName="w-fit" value={days} onChange={e => setDays(Number(e.target.value))}>
          {WINDOWS.map(d => <option key={d} value={d}>Last {d} days</option>)}
        </Select>
      </div>
      <p className="text-xs text-gray-400">
        Tokens spent on Claude calls — scoring, rewrites, structuring. Kept for 400 days.
      </p>
      {loading ? (
        <div className="flex justify-center py-8"><Spinner size="sm" /></div>
      ) : notReady ? (
        <p className="text-sm text-amber-700">Apply migration 0077 to see Claude usage.</p>
      ) : !data || data.totals.calls === 0 ? (
        <p className="text-sm text-gray-400 italic">No Claude calls recorded in this window.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Tile label="Calls" value={fmt(data.totals.calls)} />
            <Tile label="Input tokens" value={fmt(data.totals.inputTokens)} />
            <Tile label="Output tokens" value={fmt(data.totals.outputTokens)} />
            <Tile label="Tokens per scan" value={fmt(data.totals.tokensPerScan)} hint={`${fmt(data.totals.scans)} scans`} />
            <Tile label="Estimated spend" value={usd(data.totals.estimatedUsd)}
              hint={data.priced ? 'from your per-million-token prices' : 'set CLAUDE_USD_PER_MTOK_INPUT / _OUTPUT'} />
          </div>

          <h2 className="text-sm font-semibold text-gray-700 mt-2">By kind of call</h2>
          <DataTable
            caption="Claude usage by kind of call" density="compact"
            columns={[
              { key: 'label', header: 'Call', cell: r => r.label },
              { key: 'model', header: 'Model', cell: r => r.model || '—', cellClassName: 'text-gray-500' },
              ...NUM_COLS,
            ]}
            rows={data.byLabel} rowKey={r => `${r.label}|${r.model}`}
          />

          <h2 className="text-sm font-semibold text-gray-700 mt-2">By day (UTC)</h2>
          <DataTable
            caption="Claude usage by day" density="compact"
            columns={[{ key: 'day', header: 'Day', cell: r => r.day }, ...NUM_COLS]}
            rows={data.byDay} rowKey={r => r.day}
          />
        </>
      )}
    </div>
  )
}
