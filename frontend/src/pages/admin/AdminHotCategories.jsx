import { useState, useEffect, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import api, { getErrorMessage } from '../../lib/api'
import Alert from '../../components/ui/Alert'
import Badge from '../../components/ui/Badge'
import Button from '../../components/ui/Button'
import DataTable from '../../components/ui/DataTable'
import Input from '../../components/ui/Input'
import Spinner from '../../components/ui/Spinner'
import { useToast } from '../../components/ui/Toast'
import HotCategories from '../../components/home/HotCategories'
import { mergeHomeData } from '../../hooks/useHomeData'
import { ROLE_CATEGORIES, roleLabel, isRoleCategory } from '../../lib/roleCategories'
import useLatestRequest from '../../hooks/useLatestRequest'

const WINDOWS = [7, 30]

// The homepage "Hot categories" block is not published by anyone: the page ranks fields live from the interview
// reports customers give in the follow-up email, and a field only appears once it has `threshold` reports in the window.
// This screen shows how far every field is from that line, and a what-if: change the threshold or add pretend reports,
// press Run, and the preview below is rendered by the real homepage component from the answer the real endpoint would
// give. Nothing here is saved or sent to the public page — a simulation lives in this tab and in one read-only request.
export default function AdminHotCategories() {
  const toast = useToast()
  const beginLoad = useLatestRequest()
  const beginSim = useLatestRequest()
  const [real, setReal] = useState(null)          // the live counts
  const [sim, setSim] = useState(null)            // the last simulation's answer, or null
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [days, setDays] = useState(7)
  const [thresholdDraft, setThresholdDraft] = useState('')
  const [adds, setAdds] = useState({ 7: {}, 30: {} })   // draft inputs, as typed: { 7: { sales: '5' }, 30: {} }

  const load = useCallback(async () => {
    const isCurrent = beginLoad()
    setLoading(true)
    try {
      const res = await api.get('/admin/hot-categories', { signal: isCurrent.signal })
      if (!isCurrent()) return
      setReal(res.data.data)
    } catch (_) {
      if (!isCurrent()) return
      toast({ message: 'Failed to load the hot categories counts.', type: 'error' })
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [])
  useEffect(() => { load() }, [load])

  const intOrZero = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : 0 }
  const draftThreshold = thresholdDraft === '' ? null : parseInt(thresholdDraft, 10)
  const thresholdInvalid = thresholdDraft !== '' && !(Number.isInteger(draftThreshold) && draftThreshold >= 1 && draftThreshold <= 1000)
  const draftHasInput = thresholdDraft !== '' || WINDOWS.some(w => Object.values(adds[w]).some(v => intOrZero(v) > 0))

  async function runSimulation() {
    if (thresholdInvalid) return
    const isCurrent = beginSim()
    setRunning(true)
    try {
      const payload = { adds: [] }
      if (draftThreshold) payload.minReports = draftThreshold
      for (const [category] of ROLE_CATEGORIES) {
        const days7 = intOrZero(adds[7][category]), days30 = intOrZero(adds[30][category])
        if (days7 || days30) payload.adds.push({ category, days7, days30 })
      }
      const res = await api.post('/admin/hot-categories/simulate', payload, { signal: isCurrent.signal })
      if (!isCurrent()) return
      setSim(res.data.data)
    } catch (err) {
      if (!isCurrent()) return
      toast({ message: getErrorMessage(err, 'Could not run the simulation.'), type: 'error' })
    } finally {
      if (isCurrent()) setRunning(false)
    }
  }
  function reset() {
    setSim(null); setThresholdDraft(''); setAdds({ 7: {}, 30: {} })
  }
  const setAdd = (category, v) => setAdds(a => ({ ...a, [days]: { ...a[days], [category]: v } }))

  const view = sim || real
  // The homepage's own merge: with no qualifying field in a window it falls back to its labelled sample table, exactly as live.
  const preview = useMemo(() => (view ? mergeHomeData({ hotCategories: view.hotCategories }) : null), [view])

  if (loading && !real) return <div className="flex justify-center py-8"><Spinner size="sm" /></div>
  if (!real) return <Alert variant="error">Could not load the hot categories counts. <button type="button" className="underline" onClick={load}>Try again</button></Alert>

  const w = view.perWindow[days]
  const floor = view.threshold
  const known = new Set(w.fields.map(f => f.category))
  const rows = [
    ...w.fields,
    ...ROLE_CATEGORIES.filter(([k]) => !known.has(k)).map(([category]) => ({ category, current: 0, previous: 0, simulated: 0, effective: 0, qualifies: false, needed: floor, rank: null, changePct: null })),
  ]
  const realW = real.perWindow[days]
  const windowLabel = days === 7 ? 'the last 7 days' : 'the last 30 days'

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-bold text-gray-900">Hot categories</h1>
        <div role="group" aria-label="Period" className="inline-flex bg-gray-100 rounded-full p-1 text-sm">
          {WINDOWS.map(d => (
            <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}
              className={`px-4 py-1.5 rounded-full font-semibold ${days === d ? 'bg-white text-gray-900 shadow' : 'text-gray-600'}`}>{d} days</button>
          ))}
        </div>
      </div>
      <p className="text-xs text-gray-500">
        Nothing is published by hand. The public homepage ranks fields from the interview reports customers give in the follow-up email, and lists a field
        only once it has <b>{real.defaultThreshold}</b> reports in the period. Reports with no field attached are not counted. Until a field reaches the line, visitors see the
        labelled sample table.
      </p>

      {real.truncated && <Alert variant="warning">There are more interview reports than this screen reads in one go, so the counts below can be too low.</Alert>}

      <Alert variant={realW.showsSample ? 'warning' : 'success'}>
        {realW.showsSample
          ? <>Right now the homepage shows its <b>sample</b> table for {windowLabel}: no field has {real.defaultThreshold} interview reports yet.</>
          : <>Right now the homepage shows <b>real</b> data for {windowLabel}: {realW.qualifying} field{realW.qualifying === 1 ? ' is' : 's are'} listed.</>}
        {' '}{realW.interviews} interview report{realW.interviews === 1 ? '' : 's'} in {windowLabel}
        {realW.uncategorised > 0 && <>, {realW.uncategorised} without a field (not counted)</>}.
      </Alert>

      <section aria-labelledby="sim-h" className="border border-dashed border-blue-300 rounded-lg bg-blue-50/40 p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 id="sim-h" className="font-semibold text-gray-900">Simulate</h2>
            <p className="text-xs text-gray-600 mt-0.5 max-w-xl">Try a different threshold, or add pretend reports to a field in the table below, then press Run. Only this screen changes — the public homepage never sees a simulation.</p>
          </div>
          {sim && <Badge variant="blue">Simulation on</Badge>}
        </div>
        <div className="mt-3 flex items-end gap-3 flex-wrap">
          <Input label={`Threshold (live: ${real.defaultThreshold})`} size="sm" type="number" min={1} max={1000} inputMode="numeric" value={thresholdDraft}
            placeholder={String(real.defaultThreshold)} wrapperClassName="w-44" error={thresholdInvalid ? 'Use 1–1000' : undefined}
            onChange={e => setThresholdDraft(e.target.value)} />
          <Button size="sm" onClick={runSimulation} loading={running} disabled={running || thresholdInvalid || (!draftHasInput && !sim)}>Run simulation</Button>
          <Button size="sm" variant="secondary" onClick={reset} disabled={running || (!sim && !draftHasInput)}>Reset</Button>
        </div>
        {sim && (
          <p className="mt-2 text-xs text-blue-900" data-testid="sim-summary">
            Simulating with a threshold of <b>{sim.threshold}</b>
            {WINDOWS.map(d => { const n = sim.perWindow[d].fields.reduce((s, f) => s + f.simulated, 0); return n > 0 ? <span key={d}>, <b>+{n}</b> pretend reports in the {d}-day window</span> : null })}.
            {' '}The {days}-day window would show {w.showsSample ? <b>the sample table</b> : <b>real data ({w.qualifying} field{w.qualifying === 1 ? '' : 's'})</b>}.
          </p>
        )}
      </section>

      <DataTable
        caption={`Interview reports per field in ${windowLabel}, against the threshold of ${floor}`}
        density="compact"
        rows={rows}
        rowKey={r => r.category}
        columns={[
          { key: 'field', header: 'Field', cellClassName: 'font-medium text-gray-900', cell: r => roleLabel(r.category) },
          { key: 'reports', header: 'Reports', className: 'text-right', cellClassName: 'tabular-nums',
            cell: r => <>{r.effective}{r.simulated > 0 && <span className="text-blue-700 text-xs"> (+{r.simulated})</span>}</> },
          { key: 'before', header: 'Before', className: 'text-right', cellClassName: 'tabular-nums text-gray-500', cell: r => r.previous },
          { key: 'progress', header: `Toward ${floor}`, className: 'w-48', cell: r => (
            <>
              <div aria-hidden="true" className="h-2 rounded-full bg-gray-200 overflow-hidden">
                <div className={`h-full rounded-full ${r.qualifies ? 'bg-green-600' : 'bg-amber-500'}`} style={{ width: `${Math.min(100, Math.round((r.effective / floor) * 100))}%` }} />
              </div>
              <span className="text-xs text-gray-500 tabular-nums">{Math.min(r.effective, floor)} / {floor}</span>
            </>
          ) },
          { key: 'status', header: 'On the homepage', cell: r => (
            r.rank ? <Badge variant="green">Listed #{r.rank}</Badge>
              : r.qualifies ? <Badge variant="gray">Qualifies, beyond the top 12</Badge>
                : <Badge variant="amber">Needs {r.needed} more</Badge>
          ) },
          { key: 'pretend', header: '+ Pretend reports', cell: r => (
            <Input size="sm" type="number" min={0} max={10000} inputMode="numeric" wrapperClassName="w-24" placeholder="0"
              disabled={!isRoleCategory(r.category)} title={isRoleCategory(r.category) ? undefined : 'Not one of the standard fields, so it cannot be simulated'}
              aria-label={`Pretend reports for ${roleLabel(r.category)}, ${windowLabel}`}
              value={adds[days][r.category] ?? ''} onChange={e => setAdd(r.category, e.target.value)} />
          ) },
        ]}
      />
      <p className="text-xs text-gray-500">Pretend reports are added to the {days}-day window of the field you type them against. Switch the period above to set the other window; both are sent when you press Run.</p>

      <section aria-labelledby="prev-h">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
          <h2 id="prev-h" className="font-semibold text-gray-900">{sim ? 'Preview of the simulation' : 'Preview of the live section'}</h2>
          <Link to="/" target="_blank" rel="noopener noreferrer" className="text-sm text-blue-700 underline underline-offset-2">Open the live homepage ↗</Link>
        </div>
        <div className="border border-gray-200 rounded-lg overflow-hidden" data-testid="preview">
          <HotCategories hot={preview.hot} minReports={preview.minReports} />
        </div>
        <p className="text-xs text-gray-500 mt-2">Drawn by the homepage's own component from the same answer the public page receives. It has its own 7 / 30 day switch.</p>
      </section>
    </div>
  )
}
