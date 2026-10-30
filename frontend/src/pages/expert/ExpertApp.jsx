import { useCallback, useEffect, useRef, useState } from 'react'
import Button from '../../components/ui/Button'
import Input from '../../components/ui/Input'
import Textarea from '../../components/ui/Textarea'
import Alert from '../../components/ui/Alert'
import Spinner from '../../components/ui/Spinner'
import { expert } from '../../lib/expertApi'

// Experts Phase 1: the pilot expert's whole site (sign-in with a second factor, the jobs list, the workbench). Its own API client and token.
const msgOf = (e, fallback) => e?.response?.data?.message || fallback
const MARK = /\[\[(?:lock:[\w.]+|c:\d+)\]\]/

export default function ExpertApp() {
  const [stage, setStage] = useState(expert.token.get() ? 'jobs' : 'login')
  const [jobId, setJobId] = useState(null)
  const [tab, setTab] = useState('jobs')
  const out = async () => { try { await expert.logout() } catch (_) { expert.token.set(null) } setStage('login'); setJobId(null); setTab('jobs') }
  return (
    <main className="mx-auto max-w-4xl px-4 py-6">
      <header className="mb-4 flex items-center justify-between"><h1 className="text-xl font-bold text-gray-900">Passthrough Experts</h1>{stage !== 'login' && stage !== 'mfa' && stage !== 'enroll' && <Button variant="ghost" onClick={out}>Sign out</Button>}</header>
      {stage === 'login' || stage === 'mfa' || stage === 'enroll' ? <SignIn stage={stage} setStage={setStage} /> : jobId ? <Workbench id={jobId} onBack={() => setJobId(null)} onExpired={() => { expert.token.set(null); setStage('login') }} /> : (<>
        <nav className="mb-3 flex gap-2" aria-label="Sections"><Button variant={tab === 'jobs' ? 'primary' : 'ghost'} onClick={() => setTab('jobs')}>Jobs</Button><Button variant={tab === 'earnings' ? 'primary' : 'ghost'} onClick={() => setTab('earnings')}>Earnings</Button></nav>
        {tab === 'earnings' ? <Earnings onExpired={() => { expert.token.set(null); setStage('login') }} /> : <Jobs onOpen={setJobId} onExpired={() => { expert.token.set(null); setStage('login') }} />}</>)}
    </main>
  )
}

function SignIn({ stage, setStage }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [code, setCode] = useState(''); const [err, setErr] = useState(''); const [secret, setSecret] = useState(null); const [busy, setBusy] = useState(false)
  const run = async fn => { setBusy(true); setErr(''); try { await fn() } catch (e) { setErr(msgOf(e, 'That did not work.')) } finally { setBusy(false) } }
  const login = () => run(async () => { const d = await expert.login(email, password); expert.token.set(d.token); setPassword(''); if (d.stage === 'enroll') { setSecret(await expert.enrollStart()); setStage('enroll') } else setStage('mfa') })
  const mfa = () => run(async () => { const d = await expert.mfa(code); expert.token.set(d.token); setCode(''); setStage('jobs') })
  return (
    <section className="mx-auto max-w-sm space-y-3" aria-label="Sign in">
      {err && <Alert variant="error">{err}</Alert>}
      {stage === 'login' && (<><Input label="Email" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} /><Input label="Password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /><Button className="w-full" loading={busy} disabled={!email || !password} onClick={login}>Continue</Button></>)}
      {stage === 'enroll' && secret && (<div className="space-y-2 text-sm"><p>Set up your authenticator app. Add a time-based account with this key (shown once):</p><code className="block break-all rounded bg-gray-100 p-2" data-testid="totp-secret">{secret.secret}</code><p className="text-xs text-gray-500">Or open: {secret.otpauthUrl}</p></div>)}
      {(stage === 'mfa' || stage === 'enroll') && (<><Input label="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} /><Button className="w-full" loading={busy} disabled={code.length !== 6} onClick={mfa}>Sign in</Button></>)}
    </section>
  )
}

function Jobs({ onOpen, onExpired }) {
  const [jobs, setJobs] = useState(null); const [err, setErr] = useState('')
  useEffect(() => { expert.jobs().then(setJobs).catch(e => { if (e?.response?.status === 401) onExpired(); else { setErr(msgOf(e, 'Could not load your jobs.')); setJobs([]) } }) }, [onExpired])
  if (!jobs) return <Spinner />
  return (
    <section aria-label="Your jobs"><h2 className="mb-2 font-medium text-gray-900">Your jobs</h2>{err && <Alert variant="error">{err}</Alert>}
      {jobs.length === 0 && <p className="text-sm text-gray-600">Nothing is assigned to you right now.</p>}
      <ul className="space-y-2">{jobs.map(j => (
        <li key={j.id}><button type="button" className="flex w-full items-center justify-between rounded-lg border border-gray-200 bg-white p-3 text-left text-sm" onClick={() => onOpen(j.id)}>
          <span><b>{j.jobNumber}</b> {j.tierLabel}{j.coverLetter ? ' + cover letter' : ''}{j.revision ? ' (revision)' : ''}</span>
          <span className="text-gray-600">{j.state.replace('_', ' ')}{j.dueAt ? ` \u00b7 due ${new Date(j.dueAt).toLocaleString()}` : ''} \u00b7 ${(j.payCents / 100).toFixed(2)}</span></button></li>))}</ul></section>
  )
}

const money = c => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toFixed(2)}`
const KIND = { pay: 'Job pay', bonus: 'Bonus', tier_bonus: 'Tier bonus', penalty: 'Penalty', adjustment: 'Adjustment', reversal: 'Refunded job (reversed)' }
const STATUS = { paid: 'Paid', on_hold: 'On hold', available: 'Available', under_review: 'Under review' }
function Earnings({ onExpired }) {
  const [d, setD] = useState(null); const [err, setErr] = useState('')
  useEffect(() => { expert.earnings().then(setD).catch(e => { if (e?.response?.status === 401) onExpired(); else { setErr(msgOf(e, 'Could not load your earnings.')); setD({ balance: null, entries: [], payouts: [] }) } }) }, [onExpired])
  if (!d) return <Spinner />
  const b = d.balance
  return (
    <section aria-label="Your earnings" className="space-y-4"><h2 className="font-medium text-gray-900">Your earnings</h2>{err && <Alert variant="error">{err}</Alert>}
      {b && <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">{[['Available', b.availableCents], ['On hold', b.onHoldCents], ['Under review', b.underReviewCents], ['Paid so far', b.paidCents]].map(([k, v]) => (<div key={k} className="rounded-lg border border-gray-200 bg-white p-3"><dt className="text-gray-600">{k}</dt><dd className="text-lg font-semibold" data-testid={`earn-${k}`}>{money(v)}</dd></div>))}</dl>}
      <p className="text-xs text-gray-500">Pay is held for a few days after a customer accepts a job, then paid out by hand. A refunded job is taken back here as a negative line.</p>
      <div><h3 className="mb-1 text-sm font-medium text-gray-900">Entries</h3>{d.entries.length === 0 ? <p className="text-sm text-gray-600">Nothing yet.</p> : <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white text-sm">{d.entries.map(x => (<li key={x.id} className="flex items-center justify-between gap-2 p-2"><span>{KIND[x.kind] || x.kind}{x.jobNumber ? ` \u00b7 ${x.jobNumber}` : ''}{x.reason ? ` \u00b7 ${x.reason}` : ''}</span><span className="text-gray-600">{STATUS[x.status]}{x.status === 'on_hold' ? ` until ${new Date(x.releaseAt).toLocaleDateString()}` : ''} \u00b7 <b>{money(x.amountCents)}</b></span></li>))}</ul>}</div>
      <div><h3 className="mb-1 text-sm font-medium text-gray-900">Payouts</h3>{d.payouts.length === 0 ? <p className="text-sm text-gray-600">No payout yet.</p> : <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white text-sm">{d.payouts.map(x => (<li key={x.id} className="flex justify-between p-2"><span>{new Date(x.paidAt).toLocaleDateString()} \u00b7 {x.method}{x.reference ? ` \u00b7 ${x.reference}` : ''}</span><b>{money(x.amountCents)}</b></li>))}</ul>}</div>
    </section>
  )
}

// every string leaf of a masked document, rendered: read-only paths and markers are shown but cannot be edited; arrays of strings can grow and shrink
function Field({ path, value, readOnly, set }) {
  const locked = readOnly.has(path)
  const long = String(value).length > 70
  if (locked) return <div className="mb-1 flex items-center gap-2 text-sm"><span aria-hidden="true">{'\ud83d\udd12'}</span><span className="text-gray-500">{path}</span><span className="rounded bg-gray-100 px-2 py-0.5">{MARK.test(value) ? 'protected detail' : value}</span></div>
  return <Textarea aria-label={path} rows={long ? 3 : 1} value={value} onChange={e => set(path, e.target.value)} hint={MARK.test(value) ? 'Text like [[c:1]] is a protected detail. Leave it exactly where it is.' : undefined} />
}
function Tree({ node, path, readOnly, set, addItem, removeItem }) {
  if (typeof node === 'string') return <Field path={path} value={node} readOnly={readOnly} set={set} />
  if (Array.isArray(node)) {
    const strings = node.every(x => typeof x === 'string')
    return (<div className="ml-2 border-l border-gray-200 pl-3">{node.map((x, i) => (
      <div key={i}><Tree node={x} path={`${path}.${i}`} readOnly={readOnly} set={set} addItem={addItem} removeItem={removeItem} />{strings && !readOnly.has(`${path}.${i}`) && <button type="button" className="mb-2 text-xs text-gray-500 hover:underline" onClick={() => removeItem(path, i)}>Remove this line</button>}</div>))}
      {strings && <Button variant="ghost" size="sm" onClick={() => addItem(path)}>Add a line</Button>}</div>)
  }
  if (node && typeof node === 'object') return <div className="space-y-1">{Object.entries(node).map(([k, v]) => <div key={k}><p className="mt-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{path ? k : k}</p><Tree node={v} path={path ? `${path}.${k}` : k} readOnly={readOnly} set={set} addItem={addItem} removeItem={removeItem} /></div>)}</div>
  return null
}
const setAt = (obj, path, fn) => { const next = JSON.parse(JSON.stringify(obj)); const keys = path.split('.'); let cur = next; keys.slice(0, -1).forEach(k => { cur = cur[k] }); const last = keys[keys.length - 1]; cur[last] = fn(cur[last]); return next }

function Workbench({ id, onBack, onExpired }) {
  const [d, setD] = useState(null); const [body, setBody] = useState(null); const [cover, setCover] = useState(null); const [version, setVersion] = useState(0)
  const [err, setErr] = useState([]); const [msg, setMsg] = useState(''); const [dirty, setDirty] = useState(false); const [busy, setBusy] = useState(false); const [q, setQ] = useState('')
  const secs = useRef(0); const lastInput = useRef(0)
  const load = useCallback(async () => { try { const x = await expert.job(id); setD(x); setBody(x.document.body); setCover(x.document.coverLetter); setVersion(x.document.version); setDirty(false); setErr([]) } catch (e) { if (e?.response?.status === 401) onExpired(); else { setErr([msgOf(e, 'You do not have access to this job.')]); setD(false) } } }, [id, onExpired])
  useEffect(() => { load() }, [load])
  useEffect(() => { const t = setInterval(() => { if (Date.now() - lastInput.current < 30000) secs.current += 5 }, 5000); return () => clearInterval(t) }, [])
  const touch = () => { lastInput.current = Date.now(); setDirty(true); setMsg('') }
  const save = useCallback(async () => {
    if (!body) return false
    setBusy(true); setErr([])
    try { const r = await expert.save(id, { baseVersion: version, body, coverLetter: cover, seconds: Math.min(secs.current, 600) }); secs.current = 0; setVersion(r.version); setDirty(false); setMsg('Saved.'); return true }
    catch (e) { const data = e?.response?.data; setErr([data?.message || 'Could not save.', ...((data?.errors || []).map(x => `${x.path}: ${x.code}`))]); return false } finally { setBusy(false) }
  }, [body, cover, id, version])
  useEffect(() => { if (!dirty) return undefined; const t = setTimeout(() => { save() }, 15000); return () => clearTimeout(t) }, [dirty, save])
  if (d === null) return <Spinner />
  if (d === false) return <><Alert variant="error">{err[0]}</Alert><Button variant="ghost" onClick={onBack}>Back</Button></>
  const readOnly = new Set(d.readOnly); const canEdit = d.canEdit
  const ask = async () => { setBusy(true); try { await expert.ask(id, q); setQ(''); setMsg('Question sent. The clock is paused until the customer answers.'); await load() } catch (e) { setErr([msgOf(e, 'Could not send that question.')]) } finally { setBusy(false) } }
  const submit = async () => { if (dirty && !(await save())) return; setBusy(true); try { await expert.submit(id); setMsg('Sent for review.'); await load() } catch (e) { setErr([msgOf(e, 'Could not send it for review.')]) } finally { setBusy(false) } }
  return (
    <section aria-label="Workbench">
      <div className="mb-3 flex items-center justify-between"><Button variant="ghost" onClick={onBack}>{'\u2190'} Jobs</Button><span className="text-sm text-gray-600">{d.job.job_number} \u00b7 {d.job.state.replace('_', ' ')} \u00b7 {d.job.promised_deadline_at ? `due ${new Date(d.job.promised_deadline_at).toLocaleString()}` : 'no deadline'}</span></div>
      {d.job.revision_reason && <Alert variant="warning" className="mb-3">Revision requested: {d.job.revision_reason}</Alert>}
      {err.length > 0 && <Alert variant="error" className="mb-3"><ul>{err.map((e, i) => <li key={i}>{e}</li>)}</ul></Alert>}
      {msg && <Alert variant="info" className="mb-3">{msg}</Alert>}
      <details className="mb-3 rounded border border-gray-200 bg-white p-3 text-sm" open><summary className="cursor-pointer font-medium">Brief</summary>
        <dl className="mt-2 grid gap-1 sm:grid-cols-2">{[['Target role', d.brief.targetRole], ['Seniority', d.brief.seniority], ['Region', d.brief.region], ['Tone', d.brief.tone], ['Keep or avoid', d.brief.keepAvoid], ['Career story', d.brief.story], ['Notes', d.brief.notes]].filter(r => r[1]).map(([k, v]) => <div key={k}><dt className="text-xs text-gray-500">{k}</dt><dd>{v}</dd></div>)}</dl>
        {(d.brief.topResults || []).length > 0 && <p className="mt-2 text-xs text-gray-600">Confirmed results: {d.brief.topResults.map(r => `${r.result} (${r.number})`).join('; ')}</p>}
        {d.brief.jobPosting && <details className="mt-2"><summary className="cursor-pointer text-gray-600">Job posting</summary><pre className="whitespace-pre-wrap text-xs">{d.brief.jobPosting}</pre></details>}
        {d.materials.length > 0 && <details className="mt-2"><summary className="cursor-pointer text-gray-600">Supporting material ({d.materials.length})</summary>{d.materials.map(m => <pre key={m.id} className="mt-1 whitespace-pre-wrap text-xs">{m.text}</pre>)}</details>}
      </details>
      <p className="mb-2 text-xs text-gray-500">Locked lines and protected details cannot be changed. You cannot type contact details. Do not add numbers the customer has not given.</p>
      <div onInput={touch} className={canEdit ? '' : 'pointer-events-none opacity-70'}>
        <Tree node={body} path="" readOnly={readOnly} set={(p, v) => { setBody(b => setAt(b, p, () => v)); touch() }} addItem={p => { setBody(b => setAt(b, p, a => [...a, ''])); touch() }} removeItem={(p, i) => { setBody(b => setAt(b, p, a => a.filter((_, j) => j !== i))); touch() }} />
        {cover && <div className="mt-4"><p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Cover letter</p><Textarea aria-label="Cover letter" rows={10} value={cover.text} onChange={e => { setCover({ text: e.target.value }); touch() }} /></div>}
      </div>
      {d.changes.length > 0 && <details className="mt-4 text-sm"><summary className="cursor-pointer font-medium">What I have changed ({d.changes.length}) <span className="text-xs font-normal text-gray-500">(as of when you opened the job)</span></summary>
        {d.changes.map(c => <p key={c.path} className="mt-1"><span className="text-xs text-gray-500">{c.path}</span> {c.ops.map((o, i) => <span key={i} className={o.t === 'ins' ? 'bg-green-100' : o.t === 'del' ? 'bg-red-100 line-through' : ''}>{o.text}</span>)}</p>)}</details>}
      <div className="mt-4 space-y-3">
        {d.questions.map(x => <p key={x.id} className="text-sm"><b>Q{x.seq}:</b> {x.body} {x.status === 'answered' ? <><b>A:</b> {x.answer_body}</> : <em className="text-gray-500">({x.status})</em>}</p>)}
        {canEdit && d.questions.length < d.askLimit && d.job.state === 'in_progress' && <div className="flex gap-2"><Input aria-label="Ask the customer a question" placeholder="Ask one clear question (no contact details)" value={q} onChange={e => setQ(e.target.value)} /><Button variant="secondary" disabled={q.trim().length < 5 || busy} onClick={ask}>Ask</Button></div>}
        {canEdit && <div className="flex gap-2"><Button variant="secondary" loading={busy} disabled={!dirty} onClick={save}>Save</Button><Button loading={busy} onClick={submit}>Save and send for review</Button></div>}
      </div>
    </section>
  )
}
