// The expert admin console: job board with timeline, assign and reassign, the expert directory, the refund action (through the bridge, with a fresh
// password check) and the audit log viewer. Every screen shows identifiers, states and times only: no resume text, no contact details.
import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { admin, realm, errorMessage, errorCode } from '../api'
import { useSession } from '../session'
import { Page } from '../Layout'
import Button from '../../components/ui/Button'
import Alert from '../../components/ui/Alert'
import Input from '../../components/ui/Input'
import PasswordInput from '../../components/ui/PasswordInput'
import Modal from '../../components/ui/Modal'
import Spinner from '../../components/ui/Spinner'
import EmptyState from '../../components/ui/EmptyState'
import DataTable from '../../components/ui/DataTable'

const STATES = ['awaiting_payment', 'offered', 'open', 'claimed', 'in_progress', 'waiting_customer', 'in_review', 'final_checks', 'delivered', 'revision', 'accepted', 'disputed', 'refunded', 'cancelled']
const utc = v => (v ? new Date(v).toUTCString() : '')
const label = s => String(s || '').replace(/_/g, ' ')
const OFFER_STATES = ['offered', 'open'], WORK_STATES = ['claimed', 'in_progress', 'waiting_customer']

export function Board() {
  const [state, setState] = useState(''); const [jobs, setJobs] = useState(null); const [error, setError] = useState('')
  useEffect(() => { setJobs(null); admin.board(state).then(setJobs).catch(err => setError(errorMessage(err))) }, [state])
  return (
    <Page title="Job board" wide>
      <label className="text-sm block mb-3">State <select className="border rounded px-2 py-1 ml-2" value={state} onChange={e => setState(e.target.value)}><option value="">All</option>{STATES.map(s => <option key={s} value={s}>{label(s)}</option>)}</select></label>
      {error && <Alert variant="error">{error}</Alert>}{!jobs && !error && <Spinner />}
      {jobs && jobs.length === 0 && <EmptyState>No jobs in this state.</EmptyState>}
      {jobs && jobs.length > 0 && <div className="sheet"><DataTable caption="Jobs" rows={jobs} rowKey={j => j.id} density="compact" columns={[
        { key: 'job', header: 'Job', cell: j => <Link to={`/admin/jobs/${j.id}`} className="serif">{j.jobNumber}</Link> }, { key: 'state', header: 'State', cell: j => label(j.state) }, { key: 'tier', header: 'Service', cell: j => label(j.tier) },
        { key: 'expert', header: 'Expert', cell: j => (j.expert ? `${j.expert.firstName} ${j.expert.initial}.` : '') }, { key: 'due', header: 'Due', cell: j => utc(j.dueAt) },
        { key: 'next', header: 'Next', cell: j => (j.nextAction ? `${label(j.nextAction.kind)} ${utc(j.nextAction.at)}` : '') }]} /></div>}
    </Page>
  )
}

export function JobDetail() {
  const { id } = useParams(); const { me } = useSession(); const isAdmin = me && me.roles.includes('expert_admin')
  const [d, setD] = useState(null); const [experts, setExperts] = useState([]); const [error, setError] = useState(''); const [info, setInfo] = useState('')
  const [pick, setPick] = useState(''); const [reason, setReason] = useState(''); const [refundOpen, setRefundOpen] = useState(false)
  const load = useCallback(() => admin.job(id).then(setD).catch(err => setError(errorMessage(err))), [id])
  useEffect(() => { load(); if (isAdmin) admin.experts().then(setExperts).catch(() => {}) }, [load, isAdmin])
  if (!d) return <Page wide>{error ? <Alert variant="error">{error}</Alert> : <Spinner />}</Page>
  const job = d.job, canAssign = isAdmin && OFFER_STATES.includes(job.state), canReassign = isAdmin && WORK_STATES.includes(job.state)
  const canRefund = isAdmin && !['awaiting_payment', 'offered', 'open', 'refunded', 'cancelled'].includes(job.state)
  const act = async fn => { setError(''); setInfo(''); try { await fn(); await load() } catch (err) { setError(errorMessage(err)) } }
  return (
    <Page title={`Job ${job.jobNumber}`} wide>
      {error && <Alert variant="error" className="mb-3">{error}</Alert>}{info && <Alert variant="success" className="mb-3">{info}</Alert>}
      <div className="sheet p-4 mb-4 text-sm grid gap-2 sm:grid-cols-2">
        <div>State <b>{label(job.state)}</b> <span className="muted">(v{job.version})</span></div><div>Service {label(job.tier)}</div>
        <div>Expert {d.expert ? `${d.expert.firstName} ${d.expert.initial}.` : 'none'}</div><div>Due <span className="serif">{utc(job.dueAt)}</span></div>
        {d.clock && <div className={d.clock.remainingMs < 0 ? 'late pill' : ''}>{d.clock.paused ? 'Clock paused (waiting on the customer)' : d.clock.remainingMs < 0 ? 'Late' : 'On the clock'}; {Math.round(d.clock.pausedSeconds / 60)} min paused</div>}
        {d.nextAction && <div>Next: {label(d.nextAction.kind)} at {utc(d.nextAction.at)}</div>}
        {d.clockMatchesStored === false && <div className="late pill">Stored pause time does not match the events</div>}
      </div>
      {(canAssign || canReassign) && <div className="sheet p-4 mb-4 space-y-2"><h2 className="serif text-lg">{canAssign ? 'Assign' : 'Reassign'}</h2>
        <label className="text-sm block">Expert <select className="border rounded px-2 py-1 ml-2" value={pick} onChange={e => setPick(e.target.value)}><option value="">Choose...</option>
          {experts.filter(e => e.roles.includes('expert') && e.enabled && e.twoFactor).map(e => <option key={e.id} value={e.id}>{e.firstName} {e.initial}. ({e.activeJobs} active)</option>)}</select></label>
        <Input label="Reason (recorded in the audit log)" value={reason} onChange={e => setReason(e.target.value)} />
        <Button disabled={!pick || reason.trim().length < 5} onClick={() => act(async () => { await (canAssign ? admin.assign : admin.reassign)(id, pick, reason.trim()); setPick(''); setReason(''); setInfo('Done.') })}>{canAssign ? 'Assign job' : 'Move to this expert'}</Button>
        <p className="text-xs muted">{canAssign ? 'The expert sees the job on their desk straight away.' : 'The current expert loses access to the job and its draft at once; the new expert starts from the draft as it stands.'}</p></div>}
      {canRefund && <div className="mb-4"><Button variant="danger" onClick={() => setRefundOpen(true)}>Refund this order</Button></div>}
      <section className="sheet p-4"><h2 className="serif text-lg mb-2">Timeline</h2>
        <ol className="space-y-1 text-sm">{d.timeline.map(e => <li key={e.id}><span className="muted">{utc(e.at)}</span> {label(e.kind)} <span className="muted">by {e.actorKind}{e.from && e.to ? `, ${label(e.from)} to ${label(e.to)}` : ''}</span></li>)}</ol></section>
      {refundOpen && <RefundModal jobId={id} jobNumber={job.jobNumber} onClose={() => setRefundOpen(false)} onDone={() => { setRefundOpen(false); setInfo('Refund queued with the payment provider. The order updates when it completes.'); load() }} />}
    </Page>
  )
}

// A refund states its consequence first, asks for a reason, and asks for the password again (step-up). The request key is made once per opening, so a
// double click or a retry after a timeout cannot send two refunds.
function RefundModal({ jobId, jobNumber, onClose, onDone }) {
  const [reason, setReason] = useState(''); const [amount, setAmount] = useState(''); const [pw, setPw] = useState(''); const [needPw, setNeedPw] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const [key] = useState(() => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `refund-${Date.now()}-${Math.random().toString(16).slice(2)}`))
  async function send() {
    setBusy(true); setError('')
    try {
      if (needPw) { await realm.stepUp(pw); setPw(''); setNeedPw(false) }
      const cents = amount.trim() ? Math.round(parseFloat(amount) * 100) : undefined
      if (amount.trim() && !(cents > 0)) { setError('Enter a valid amount, or leave it empty for the full refund.'); return }
      await admin.refund(jobId, { reason: reason.trim(), amountCents: cents, idemKey: key }); onDone()
    } catch (err) { if (errorCode(err) === 'STEP_UP_REQUIRED') setNeedPw(true); else setError(errorMessage(err)) } finally { setBusy(false) }
  }
  return (
    <Modal open onClose={onClose} title={`Refund order ${jobNumber}`}>
      <div className="space-y-3 text-sm">
        <p>This sends the customer's money back through the payment provider and cannot be undone. The expert's pay for this job is reversed when the refund completes. Leave the amount empty to refund everything that is left.</p>
        {error && <Alert variant="error" focusOnShow>{error}</Alert>}
        <Input label="Amount in dollars (optional)" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} />
        <Input label="Reason (5 to 300 characters, recorded)" value={reason} onChange={e => setReason(e.target.value)} />
        {needPw && <PasswordInput label="Confirm your password to continue" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} />}
        <div className="flex gap-2 justify-end"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" loading={busy} disabled={reason.trim().length < 5 || (needPw && !pw)} onClick={send}>{needPw ? 'Confirm and refund' : 'Refund'}</Button></div>
      </div>
    </Modal>
  )
}

export function Directory() {
  const [rows, setRows] = useState(null); const [error, setError] = useState('')
  useEffect(() => { admin.experts().then(setRows).catch(err => setError(errorMessage(err))) }, [])
  return (
    <Page title="Experts" wide>
      {error && <Alert variant="error">{error}</Alert>}{!rows && !error && <Spinner />}
      {rows && <div className="sheet"><DataTable caption="Experts and staff" rows={rows} rowKey={e => e.id} density="compact" columns={[
        { key: 'name', header: 'Name', cell: e => `${e.firstName} ${e.initial}.` }, { key: 'roles', header: 'Roles', cell: e => e.roles.join(', ') },
        { key: 'status', header: 'Status', cell: e => (e.enabled ? e.status : `${e.status} (disabled)`) }, { key: 'tf', header: 'Two-factor', cell: e => (e.twoFactor ? 'Yes' : 'No') },
        { key: 'jobs', header: 'Active jobs', cell: e => <span className="serif">{e.activeJobs}</span> }, { key: 'last', header: 'Last sign-in', cell: e => utc(e.lastSignIn) }]} /></div>}
    </Page>
  )
}

export function AuditLog() {
  const [rows, setRows] = useState([]); const [next, setNext] = useState(null); const [action, setAction] = useState(''); const [error, setError] = useState(''); const [loaded, setLoaded] = useState(false)
  const load = useCallback(async (before, append) => {
    try { const r = await admin.audit({ ...(before ? { before } : {}), ...(action ? { action } : {}) }); setRows(p => (append ? [...p, ...r.entries] : r.entries)); setNext(r.nextBefore); setLoaded(true) } catch (err) { setError(errorMessage(err)) }
  }, [action])
  useEffect(() => { load(null, false) }, [load])
  return (
    <Page title="Audit log" wide>
      <Input label="Filter by action (exact, for example money.refund_queued)" value={action} onChange={e => setAction(e.target.value.trim())} wrapperClassName="mb-3 max-w-md" />
      {error && <Alert variant="error">{error}</Alert>}{!loaded && !error && <Spinner />}
      {loaded && rows.length === 0 && <EmptyState>No entries.</EmptyState>}
      {rows.length > 0 && <div className="sheet"><DataTable caption="Audit log" rows={rows} rowKey={r => r.id} density="compact" columns={[
        { key: 'at', header: 'When (UTC)', cell: r => utc(r.created_at) }, { key: 'who', header: 'Who', cell: r => <>{r.actor_kind} <span className="muted">{r.actor_id ? String(r.actor_id).slice(0, 8) : ''}</span></> },
        { key: 'action', header: 'Action', cell: r => r.action }, { key: 'target', header: 'Target', cell: r => <>{r.target_type} <span className="muted">{r.target_id ? String(r.target_id).slice(0, 8) : ''}</span></> },
        { key: 'detail', header: 'Detail', cell: r => Object.entries(r.detail || {}).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('+') : v}`).join(' '), cellClassName: 'text-gray-500' }]} /></div>}
      {next && <div className="mt-3"><Button variant="secondary" onClick={() => load(next, true)}>Older entries</Button></div>}
    </Page>
  )
}
