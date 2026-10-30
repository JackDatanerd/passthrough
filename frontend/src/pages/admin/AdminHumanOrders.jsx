import { useCallback, useEffect, useRef, useState } from 'react'
import api, { getErrorMessage } from '../../lib/api'
import Button from '../../components/ui/Button'
import Input from '../../components/ui/Input'
import Textarea from '../../components/ui/Textarea'
import Select from '../../components/ui/Select'
import Checkbox from '../../components/ui/Checkbox'
import Alert from '../../components/ui/Alert'
import Spinner from '../../components/ui/Spinner'
import DataTable from '../../components/ui/DataTable'
import ConfirmDialog from '../../components/ui/ConfirmDialog'

// Experts Phase 1: the operator's inbox for human orders, inside the existing admin area. List, filter by state, view the brief, assign by
// hand, review and deliver, record minutes and costs, refund, accept, manage the pilot experts and record manual payouts.
const STATES = ['', 'offered', 'claimed', 'in_progress', 'waiting_customer', 'in_review', 'delivered', 'revision', 'accepted', 'awaiting_payment', 'refunded', 'cancelled']
const usd = c => `$${((c || 0) / 100).toFixed(2)}`
const H = '/admin/human'

export default function AdminHumanOrders() {
  const [tab, setTab] = useState('orders')
  return (
    <div>
      <h1 className="mb-3 text-xl font-bold text-gray-900">Human orders</h1>
      <div className="mb-4 flex gap-2" role="tablist">{['orders', 'experts', 'summary'].map(t => <Button key={t} role="tab" aria-selected={tab === t} variant={tab === t ? 'primary' : 'secondary'} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</Button>)}</div>
      {tab === 'orders' && <Orders />}{tab === 'experts' && <Experts />}{tab === 'summary' && <Summary />}
    </div>
  )
}

function Orders() {
  const [state, setState] = useState(''); const [data, setData] = useState(null); const [err, setErr] = useState(''); const [sel, setSel] = useState(null)
  const load = useCallback(async () => { try { setData((await api.get(`${H}/orders${state ? `?state=${state}` : ''}`)).data.data); setErr('') } catch (e) { setErr(getErrorMessage(e, 'Could not load orders.')); setData({ orders: [], counts: {} }) } }, [state])
  useEffect(() => { load() }, [load])
  if (!data) return <Spinner />
  return (
    <div>
      {err && <Alert variant="error" className="mb-2">{err}</Alert>}
      <div className="mb-2 flex flex-wrap items-center gap-3 text-sm">
        <Select aria-label="Filter by state" value={state} onChange={e => setState(e.target.value)}>{STATES.map(s => <option key={s} value={s}>{s ? `${s.replace('_', ' ')} (${data.counts[s] || 0})` : 'All states'}</option>)}</Select>
        {data.capacity && <span className="text-gray-600">Pilot: {data.capacity.paid} of {data.capacity.cap} paid orders</span>}
      </div>
      <DataTable caption="Human orders" density="compact" rows={data.orders} rowKey={o => o.id} empty="No orders here."
        columns={[
          { key: 'order', header: 'Order', cell: o => <><button type="button" className="font-semibold text-blue-700 hover:underline" onClick={() => setSel(o.id)}>{o.jobNumber}</button> <span className="text-gray-600">{o.tier.replace('_', ' ')}{o.coverLetter ? ' +CL' : ''}</span></> },
          { key: 'state', header: 'State', cell: o => <>{o.state.replace('_', ' ')}{o.overdue ? ' \u26a0 overdue' : ''}{o.paymentStatus && o.paymentStatus !== 'SUCCESS' ? ` (${o.paymentStatus})` : ''}</> },
          { key: 'customer', header: 'Customer', cell: o => o.customer },
          { key: 'expert', header: 'Expert', cell: o => o.expert || '\u2014' },
          { key: 'due', header: 'Due', cell: o => (o.dueAt ? new Date(o.dueAt).toLocaleString() : '\u2014') },
          { key: 'money', header: 'Price / pay', cell: o => `${usd(o.priceCents)} / ${usd(o.payCents)}` },
        ]} />
      {sel && <OrderPanel id={sel} onClose={() => { setSel(null); load() }} />}
    </div>
  )
}

function OrderPanel({ id, onClose }) {
  const [d, setD] = useState(null); const [experts, setExperts] = useState([]); const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [pick, setPick] = useState(''); const [rev, setRev] = useState(null)
  const [askRefund, setAskRefund] = useState(false); const [conf, setConf] = useState([]); const [override, setOverride] = useState(''); const [summary, setSummary] = useState(''); const [note, setNote] = useState(''); const [rec, setRec] = useState({ expertMinutes: '', otherCostCents: '' }); const [credit, setCredit] = useState(''); const [busy, setBusy] = useState(false)
  const load = useCallback(async () => { try { setD((await api.get(`${H}/orders/${id}`)).data.data) } catch (e) { setErr(getErrorMessage(e, 'Could not load that order.')) } }, [id])
  useEffect(() => { load(); api.get(`${H}/experts`).then(r => setExperts(r.data.data.experts)).catch(() => {}) }, [load])
  const run = async (fn, ok) => { setBusy(true); setErr(''); setMsg(''); try { await fn(); if (ok) setMsg(ok); await load() } catch (e) { const r = e?.response?.data; setErr(r?.message || getErrorMessage(e, 'That did not work.')); if (r?.figures) setRev(v => ({ ...(v || {}), blocked: r.figures })) } finally { setBusy(false) } }
  if (!d) return <div className="mt-4">{err ? <Alert variant="error">{err}</Alert> : <Spinner />}</div>
  const j = d.job
  const openReview = () => run(async () => { setRev((await api.get(`${H}/orders/${id}/review`)).data.data); setConf([]) })
  return (
    <div className="mt-4 rounded-lg border border-gray-300 bg-white p-4 text-sm" role="dialog" aria-label={`Order ${j.job_number}`}>
      <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">{j.job_number} <span className="text-gray-500">{j.state.replace('_', ' ')}</span></h2><Button variant="ghost" onClick={onClose}>Close</Button></div>
      {err && <Alert variant="error" className="my-2">{err}</Alert>}{msg && <Alert variant="info" className="my-2">{msg}</Alert>}
      <p className="text-gray-700">{d.customer?.email} \u00b7 {usd(j.price_cents)} (pay {usd(j.expert_pay_cents)}) \u00b7 payment {d.payment?.status} \u00b7 {j.tier.replace('_', ' ')}{j.add_cover_letter ? ' + cover letter' : ''}{d.expert ? ` \u00b7 ${d.expert.display_first_name} ${d.expert.display_initial}.` : ''}</p>
      <p className="text-gray-600">Active editing: {d.activeMinutes} min \u00b7 questions: {d.questions.length} \u00b7 revision: {j.revision_count ? 'used' : 'not used'} \u00b7 consents: terms, 18+, rights{j.learning_consent ? ', improvement' : ''}</p>
      <details className="mt-2"><summary className="cursor-pointer font-medium">Brief</summary><pre className="whitespace-pre-wrap text-xs">{JSON.stringify(j.brief, null, 2)}</pre></details>
      {d.materials.length > 0 && <p className="mt-1">Materials: {d.materials.map(m => m.kind === 'link' ? <a key={m.id} href={m.url} target="_blank" rel="noreferrer noopener" className="mr-2 text-blue-700 underline">{m.url}</a> : <span key={m.id} className="mr-2">{m.label} ({m.textChars} chars)</span>)}</p>}
      {d.questions.map(q => <p key={q.seq} className="mt-1 text-xs"><b>Q{q.seq}</b> {q.body} \u2192 {q.answer_body || `(${q.status})`}</p>)}

      {['offered', 'open'].includes(j.state) && (<div className="mt-3 flex items-end gap-2"><Select label="Assign to" value={pick} onChange={e => setPick(e.target.value)}><option value="">Choose an expert</option>{experts.filter(x => x.enabled && x.twoFactor && x.agreementSigned).map(x => <option key={x.id} value={x.id}>{x.name} ({x.openJobs} open)</option>)}</Select>
        <Button disabled={!pick || busy} onClick={() => run(() => api.post(`${H}/orders/${id}/assign`, { expertId: pick }), 'Assigned.')}>Assign</Button></div>)}
      {['claimed', 'in_progress', 'waiting_customer'].includes(j.state) && <Button className="mt-3" variant="secondary" disabled={busy} onClick={() => run(() => api.post(`${H}/orders/${id}/unassign`, {}), 'Taken back.')}>Take it back from the expert</Button>}

      {j.state === 'in_review' && !rev && <Button className="mt-3" onClick={openReview} disabled={busy}>Review and deliver</Button>}
      {rev && rev.resume && (
        <div className="mt-3 space-y-2 rounded border border-gray-200 p-3">
          <p>ATS score {rev.scoreBefore ?? '?'} \u2192 {rev.scoreAfter ?? '?'}. {rev.missing.length ? <b className="text-red-700">Locked details missing: {rev.missing.join(', ')}</b> : 'All locked details are in place.'}</p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-2 text-xs">{JSON.stringify(rev.resume, null, 2)}</pre>
          {rev.cover && <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-2 text-xs">{rev.cover}</pre>}
          {rev.newFigures.length > 0 && <div><p className="font-medium text-amber-800">Figures that are in nothing the customer gave us:</p>{rev.newFigures.map(f => <Checkbox key={f} label={`${f}: confirmed with the customer${({ ai_draft: ' (only in the AI draft)', job_posting: ' (only in the job posting)' })[(rev.newFigureDetails || []).find(d => d.text === f)?.origin] || ''}`} checked={conf.includes(f)} onChange={e => setConf(c => e.target.checked ? [...c, f] : c.filter(x => x !== f))} />)}<Input label="Or override with a reason" value={override} onChange={e => setOverride(e.target.value)} /></div>}
          <Textarea label="Summary shown to the customer" rows={2} value={summary} onChange={e => setSummary(e.target.value)} /><Textarea label="Note (kept on the order)" rows={2} value={note} onChange={e => setNote(e.target.value)} />
          <div className="flex gap-2"><Button disabled={busy || rev.missing.length > 0} onClick={() => run(async () => { await api.post(`${H}/orders/${id}/deliver`, { summary, note, confirmed: conf, overrideReason: override || undefined }); setRev(null) }, 'Delivered. The customer has been emailed.')}>Deliver to the customer</Button>
            <Button variant="secondary" disabled={busy || note.trim().length < 3} onClick={() => run(async () => { await api.post(`${H}/orders/${id}/return`, { note }); setRev(null) }, 'Sent back to the expert.')}>Send back to the expert (needs a note)</Button></div>
        </div>)}

      {d.deliveries.length > 0 && <p className="mt-2 text-xs text-gray-600">Deliveries: {d.deliveries.map(x => `v${x.version} ${x.score_before ?? '?'}\u2192${x.score_after ?? '?'}`).join(', ')}</p>}
      <div className="mt-3 grid grid-cols-2 gap-2"><Input label="Expert minutes (override)" inputMode="numeric" value={rec.expertMinutes} onChange={e => setRec(r => ({ ...r, expertMinutes: e.target.value }))} /><Input label="Other cost (cents)" inputMode="numeric" value={rec.otherCostCents} onChange={e => setRec(r => ({ ...r, otherCostCents: e.target.value }))} /></div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="secondary" disabled={busy} onClick={() => run(() => api.post(`${H}/orders/${id}/record`, Object.fromEntries(Object.entries({ expertMinutes: rec.expertMinutes, otherCostCents: rec.otherCostCents }).filter(([, v]) => v !== '').map(([k, v]) => [k, Number(v)]))), 'Recorded.')}>Record</Button>
        {j.paid_at && d.payment?.status === 'SUCCESS' && !['awaiting_payment', 'cancelled', 'refunded'].includes(j.state) && (<span className="flex items-end gap-1"><Input label={`Late credit (cents, given so far ${usd(j.late_credit_cents || 0)})`} inputMode="numeric" value={credit} onChange={e => setCredit(e.target.value.replace(/\D/g, ''))} />
          <Button variant="secondary" disabled={busy || !credit || Number(credit) <= 0} onClick={() => run(async () => { await api.post(`${H}/orders/${id}/late-credit`, { amountCents: Number(credit) }); setCredit('') }, 'Credit sent to the customer as a partial refund.')}>Send credit</Button></span>)}
        {j.state === 'delivered' && <Button variant="secondary" disabled={busy} onClick={() => run(() => api.post(`${H}/orders/${id}/accept`, {}), 'Accepted for the customer.')}>Mark accepted</Button>}
        {['offered', 'claimed', 'in_progress', 'waiting_customer', 'in_review', 'delivered', 'revision', 'accepted'].includes(j.state) && d.payment?.status === 'SUCCESS' && <Button variant="danger" disabled={busy} onClick={() => setAskRefund(true)}>Refund</Button>}
      </div>
      <ConfirmDialog open={askRefund} title="Refund this order" message={`Refund ${j.job_number} (${usd(j.price_cents)}) in full? The job closes when Paystack confirms the refund.`} confirmLabel="Refund" loading={busy}
        onConfirm={() => { setAskRefund(false); run(() => api.post(`${H}/orders/${id}/refund`, {}), 'Refund started. The job closes when Paystack confirms it.') }} onCancel={() => setAskRefund(false)} />
      <details className="mt-3"><summary className="cursor-pointer text-gray-600">History</summary>{d.events.map((e, i) => <p key={i} className="text-xs text-gray-600">{new Date(e.created_at).toLocaleString()} \u00b7 {e.kind} ({e.actor_kind})</p>)}</details>
    </div>
  )
}

function Experts() {
  const [list, setList] = useState(null); const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [f, setF] = useState({ email: '', firstName: '', initial: '' }); const [pay, setPay] = useState({}); const [busy, setBusy] = useState(false); const [open, setOpen] = useState(null); const keys = useRef({})
  const keyFor = id => { if (!keys.current[id]) keys.current[id] = `po-${id.slice(0, 8)}-${crypto.randomUUID()}`; return keys.current[id] }   // one key per ATTEMPT (kept across a retry, replaced after a success), never derived from what was typed
  const load = useCallback(async () => { try { setList((await api.get(`${H}/experts`)).data.data.experts) } catch (e) { setErr(getErrorMessage(e, 'Could not load experts.')); setList([]) } }, [])
  useEffect(() => { load() }, [load])
  const run = async (fn, ok) => { setBusy(true); setErr(''); setMsg(''); try { const r = await fn(); setMsg(typeof ok === 'function' ? ok(r) : ok); await load() } catch (e) { setErr(e?.response?.data?.message || getErrorMessage(e, 'That did not work.')) } finally { setBusy(false) } }
  const patch = (id, body, ok) => run(() => api.patch(`${H}/experts/${id}`, body), r => r.data.data?.temporaryPassword ? `${ok} Temporary password (shown once): ${r.data.data.temporaryPassword}` : ok)
  if (!list) return <Spinner />
  return (
    <div className="space-y-4">
      {err && <Alert variant="error">{err}</Alert>}{msg && <Alert variant="info">{msg}</Alert>}
      <DataTable caption="Pilot experts" density="compact" rows={list} rowKey={x => x.id} empty="No experts yet."
        columns={[
          { key: 'expert', header: 'Expert', cell: x => <>{x.name}<br /><span className="text-xs text-gray-500">{x.email}</span></> },
          { key: 'status', header: 'Status', cell: x => `${x.status}${x.enabled ? ' \u00b7 ON' : ' \u00b7 off'}` },
          { key: 'setup', header: 'Setup', cellClassName: 'text-xs', cell: x => `${x.twoFactor ? '2FA \u2713' : '2FA \u2717'} \u00b7 ${x.agreementSigned ? 'agreement \u2713' : 'agreement \u2717'}` },
          { key: 'open', header: 'Open', cell: x => x.openJobs },
          { key: 'money', header: 'Available / hold / paid', cell: x => `${usd(x.availableCents)} / ${usd(x.onHoldCents)} / ${usd(x.paidCents)}${x.frozenCents ? ` \u00b7 ${usd(x.frozenCents)} frozen (payment disputed)` : ''}` },
          { key: 'actions', header: <span className="sr-only">Actions</span>, cellClassName: 'whitespace-nowrap', cell: x => (
            <div className="flex flex-wrap items-center gap-1">
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => patch(x.id, { enabled: !x.enabled }, x.enabled ? 'Switched off.' : 'Switched on.')}>{x.enabled ? 'Switch off' : 'Switch on'}</Button>
              {!x.agreementSigned && <Button size="sm" variant="secondary" disabled={busy} onClick={() => patch(x.id, { agreementSigned: true }, 'Agreement marked signed.')}>Agreement signed</Button>}
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => patch(x.id, { resetTwoFactor: true }, 'Two-factor reset.')}>Reset 2FA</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => patch(x.id, { resetPassword: true }, 'Password reset.')}>Reset password</Button>
              <Input aria-label={`Payment reference for ${x.name}`} placeholder="M-Pesa ref" value={pay[x.id] || ''} onChange={e => setPay(p => ({ ...p, [x.id]: e.target.value }))} />
              <Button size="sm" disabled={busy || x.availableCents <= 0 || !(pay[x.id] || '').trim()} onClick={() => run(() => api.post(`${H}/payouts`, { expertId: x.id, method: 'manual', reference: pay[x.id].trim(), idempotencyKey: keyFor(x.id) }), r => { delete keys.current[x.id]; setPay(p => ({ ...p, [x.id]: '' })); return `Recorded ${usd(r.data.data.amount_cents)}${r.data.data.already ? ' (already recorded)' : ''}.` })}>Record payout</Button>
              <Button size="sm" variant="ghost" onClick={() => setOpen(open === x.id ? null : x.id)}>{open === x.id ? 'Hide ledger' : 'Ledger'}</Button>
            </div>) },
        ]} />
      {open && <Ledger expertId={open} onChanged={load} />}
      <div className="grid gap-2 sm:grid-cols-4"><Input label="Email" value={f.email} onChange={e => setF(x => ({ ...x, email: e.target.value }))} /><Input label="First name" value={f.firstName} onChange={e => setF(x => ({ ...x, firstName: e.target.value }))} /><Input label="Initial" maxLength={2} value={f.initial} onChange={e => setF(x => ({ ...x, initial: e.target.value }))} />
        <Button className="self-end" disabled={busy || !f.email || !f.firstName || !f.initial} onClick={() => run(async () => { const r = await api.post(`${H}/experts`, f); setF({ email: '', firstName: '', initial: '' }); return r }, r => `Created. Temporary password (shown once): ${r.data.data.temporaryPassword}. The account is OFF until you switch it on.`)}>Create expert</Button></div>
    </div>
  )
}

function Ledger({ expertId, onChanged }) {
  const [d, setD] = useState(null); const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false)
  const [f, setF] = useState({ kind: 'bonus', amount: '', reason: '' }); const [why, setWhy] = useState({}); const key = useRef(null)
  const load = useCallback(async () => { try { setD((await api.get(`${H}/experts/${expertId}/ledger`)).data.data); setErr('') } catch (e) { setErr(getErrorMessage(e, 'Could not load the ledger.')) } }, [expertId])
  useEffect(() => { setD(null); load() }, [load])
  const run = async (fn, ok) => { setBusy(true); setErr(''); setMsg(''); try { await fn(); setMsg(ok); await load(); onChanged() } catch (e) { setErr(e?.response?.data?.message || getErrorMessage(e, 'That did not work.')) } finally { setBusy(false) } }
  const cents = Math.round(Number(f.amount) * 100); const signed = f.kind === 'penalty' ? -Math.abs(cents) : f.kind === 'adjustment' ? cents : Math.abs(cents)
  if (!d) return err ? <Alert variant="error">{err}</Alert> : <Spinner />
  return (
    <section aria-label="Expert ledger" className="space-y-3 rounded-lg border border-gray-200 bg-white p-3 text-sm">
      {err && <Alert variant="error">{err}</Alert>}{msg && <Alert variant="info">{msg}</Alert>}
      <div className="grid items-end gap-2 sm:grid-cols-5"><Select label="Entry" value={f.kind} onChange={e => setF(x => ({ ...x, kind: e.target.value }))}><option value="bonus">Bonus</option><option value="tier_bonus">Tier bonus</option><option value="penalty">Penalty</option><option value="adjustment">Adjustment (+/-)</option></Select>
        <Input label="Amount (USD)" inputMode="decimal" value={f.amount} onChange={e => setF(x => ({ ...x, amount: e.target.value.replace(/[^\d.-]/g, '') }))} /><div className="sm:col-span-2"><Input label="Reason (shown to the expert)" value={f.reason} onChange={e => setF(x => ({ ...x, reason: e.target.value }))} /></div>
        <Button disabled={busy || !Number.isFinite(signed) || signed === 0 || f.reason.trim().length < 3} onClick={() => run(async () => { if (!key.current) key.current = `adj-${crypto.randomUUID()}`; await api.post(`${H}/experts/${expertId}/adjustments`, { kind: f.kind, amountCents: signed, reason: f.reason.trim(), idempotencyKey: key.current }); key.current = null; setF({ kind: f.kind, amount: '', reason: '' }) }, 'Entry added.')}>Add entry</Button></div>
      <div><h4 className="mb-1 font-medium">Payouts</h4>{d.payouts.length === 0 ? <p className="text-gray-600">None yet.</p> : <ul className="space-y-1">{d.payouts.map(x => (<li key={x.id} className="flex flex-wrap items-center gap-2"><span className={x.voided ? 'text-gray-400 line-through' : ''}>{new Date(x.paidAt).toLocaleDateString()} \u00b7 {usd(x.amountCents)} \u00b7 {x.method}{x.reference ? ` \u00b7 ${x.reference}` : ''}</span>{x.voided ? <span className="text-xs text-gray-500">void: {x.voidReason}</span> : (<><Input aria-label="Void reason" placeholder="Why void it?" value={why[x.id] || ''} onChange={e => setWhy(w => ({ ...w, [x.id]: e.target.value }))} /><Button size="sm" variant="danger" disabled={busy || (why[x.id] || '').trim().length < 3} onClick={() => run(() => api.post(`${H}/payouts/${x.id}/void`, { reason: why[x.id].trim() }), 'Payout voided; its earnings are available again.')}>Void</Button></>)}</li>))}</ul>}</div>
      <div><h4 className="mb-1 font-medium">Entries</h4>{d.earnings.length === 0 ? <p className="text-gray-600">None yet.</p> : <ul className="divide-y divide-gray-100">{d.earnings.map(x => (<li key={x.id} className="flex justify-between gap-2 py-1"><span>{x.kind}{x.jobNumber ? ` \u00b7 ${x.jobNumber}` : ''}{x.reason ? ` \u00b7 ${x.reason}` : ''}</span><span className="text-gray-600">{x.status}{x.status === 'held' ? ` until ${new Date(x.releaseAt).toLocaleDateString()}` : ''} \u00b7 <b>{usd(x.amountCents)}</b></span></li>))}</ul>}</div>
    </section>
  )
}

function Summary() {
  const [s, setS] = useState(null); const [err, setErr] = useState('')
  useEffect(() => { api.get(`${H}/summary`).then(r => setS(r.data.data)).catch(e => setErr(getErrorMessage(e, 'Could not load the summary.'))) }, [])
  if (err) return <Alert variant="error">{err}</Alert>
  if (!s) return <Spinner />
  const rows = [['Paid orders', s.paid], ['Delivered', s.delivered], ['Accepted', s.accepted], ['Refunded', s.refunded], ['On time', s.onTimePct == null ? '\u2014' : `${s.onTimePct}%`], ['Needed the revision', s.revisionPct == null ? '\u2014' : `${s.revisionPct}%`],
    ['Average expert minutes', s.avgMinutes ?? '\u2014'], ['Average rating', s.avgRating ?? '\u2014'], ['Average score gain', s.avgScoreGain ?? '\u2014'], ['Revenue', usd(s.revenueCents)], ['Cost (pay + other)', usd(s.costCents)], ['Margin', `${usd(s.marginCents)}${s.marginPct == null ? '' : ` (${s.marginPct}%)`}`]]
  return <dl className="grid max-w-xl grid-cols-2 gap-2 text-sm">{rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-gray-600">{k}</dt><dd className="font-medium">{v}</dd></div>)}</dl>
}
