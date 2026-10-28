import { useEffect, useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import Button from '../../components/ui/Button'
import Input from '../../components/ui/Input'
import Textarea from '../../components/ui/Textarea'
import Select from '../../components/ui/Select'
import Checkbox from '../../components/ui/Checkbox'
import RadioGroup from '../../components/ui/RadioGroup'
import Alert from '../../components/ui/Alert'
import Spinner from '../../components/ui/Spinner'
import { getErrorMessage } from '../../lib/api'
import { human, money } from '../../lib/humanApi'

// Experts Phase 1: the brief and checkout for a human order. Wording is the server's (docs/experts/phase0/06-checkout-wording).
const EMPTY = { targetRole: '', seniority: '', jobPosting: '', region: 'US', keepAvoid: '', story: '', tone: 'balanced', notes: '' }
const hoursLabel = h => (h ? (h >= 48 ? `${Math.round(h / 24)} days` : `${h} hours`) : '')

export default function HumanOrder() {
  const [params] = useSearchParams(); const navigate = useNavigate()
  const scanId = params.get('scanId')
  const [cfg, setCfg] = useState(null); const [loadErr, setLoadErr] = useState('')
  const [tier, setTier] = useState(''); const [cover, setCover] = useState(false); const [brief, setBrief] = useState(EMPTY)
  const [results, setResults] = useState([{ result: '', number: '', confirmer: '' }, { result: '', number: '', confirmer: '' }, { result: '', number: '', confirmer: '' }])
  const [ticks, setTicks] = useState({ terms: false, age: false, rights: false, learning: false })
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [note, setNote] = useState('')
  const [order, setOrder] = useState(null); const [files, setFiles] = useState([]); const [link, setLink] = useState('')

  useEffect(() => { human.config().then(setCfg).catch(e => setLoadErr(getErrorMessage(e, 'Human rewrite is not available.'))) }, [])
  if (!scanId) return <Page><Alert variant="error">Choose a resume to rewrite first.</Alert></Page>
  if (loadErr) return <Page><Alert variant="error">{loadErr}</Alert></Page>
  if (!cfg) return <Page><Spinner /></Page>
  if (!cfg.available) return <Page><Alert variant="info">{cfg.atCapacity ? 'We are at capacity for human rewrites right now. Please try again later.' : 'Human rewrite is not available on your account yet.'}</Alert></Page>
  const w = cfg.wording
  const chosen = cfg.tiers.find(t => t.tier === tier)
  const total = chosen ? chosen.priceCents + (cover ? cfg.coverLetterCents : 0) : 0
  const set = k => e => setBrief(b => ({ ...b, [k]: e.target.value }))
  const ready = !!chosen && brief.targetRole.trim().length >= 2 && ticks.terms && ticks.age && ticks.rights

  const submit = async () => {
    setBusy(true); setErr(''); setNote('')
    const body = { scanId, tier, addCoverLetter: cover, brief: { ...brief, topResults: results.filter(r => r.result.trim()) }, consents: { terms: true, age: true, rights: true, learning: ticks.learning } }
    try {
      let d
      try { d = await human.create(body) }
      catch (e) {
        if (e?.response?.data?.code === 'NO_STRUCTURED_RESUME') { setNote('Reading your resume\u2026'); await human.structure(scanId); d = await human.create(body) } else throw e
      }
      setOrder(d); setNote(d.codeIgnored || '')
    } catch (e) { setErr(getErrorMessage(e, 'We could not start your order. Please try again.')) } finally { setBusy(false) }
  }
  const pay = () => { if (order?.authorizationUrl) window.location.assign(order.authorizationUrl); else setErr('Payment could not be opened. Please try again.') }
  const upload = async f => { if (!f) return; setErr(''); try { await human.upload(order.orderId, f); setFiles(x => [...x, f.name]) } catch (e) { setErr(getErrorMessage(e, 'That file could not be added.')) } }
  const addLink = async () => { if (!link.trim()) return; setErr(''); try { await human.addLink(order.orderId, link.trim()); setFiles(x => [...x, link.trim()]); setLink('') } catch (e) { setErr(getErrorMessage(e, 'That link could not be added.')) } }

  if (order) return (
    <Page title="Almost there">
      {note && <Alert variant="info" className="mb-3">{note}</Alert>}
      {err && <Alert variant="error" className="mb-3">{err}</Alert>}
      <p className="text-sm text-gray-700">Your order <b>{order.orderId.slice(0, 8)}</b> is ready for payment: <b>{money(order.priceCents)}</b>.</p>
      <section className="mt-4 rounded-lg border border-gray-200 bg-white p-4" aria-label="Supporting materials">
        <h2 className="font-medium text-gray-900">Supporting materials (optional)</h2>
        <p className="text-sm text-gray-600">{w.materials}</p>
        <p className="mt-1 text-xs text-gray-500">Up to {cfg.materials.maxFiles} Word or text-based PDF files, {Math.round(cfg.materials.maxBytes / 1048576)} MB each. The expert sees only the text, with contact details hidden. Links are kept for our team, not shown to the expert.</p>
        <input type="file" accept=".pdf,.docx" aria-label="Add a file" className="mt-2 block text-sm" onChange={e => upload(e.target.files?.[0])} />
        <div className="mt-2 flex gap-2"><Input aria-label="Add a link" placeholder="https://" value={link} onChange={e => setLink(e.target.value)} /><Button variant="secondary" onClick={addLink}>Add link</Button></div>
        {files.length > 0 && <ul className="mt-2 list-disc pl-5 text-sm text-gray-700">{files.map(f => <li key={f}>{f}</li>)}</ul>}
      </section>
      <p className="mt-4 text-xs text-gray-500">{w.terms}</p>
      <Button className="mt-3 w-full" size="lg" onClick={pay}>Pay {money(order.priceCents)}</Button>
    </Page>
  )

  return (
    <Page title="Order a human rewrite">
      {err && <Alert variant="error" className="mb-3">{err}</Alert>}
      <div className="mb-4">
        <RadioGroup legend="How fast?" value={tier} onChange={setTier}
          options={cfg.tiers.map(t => ({ value: t.tier, label: `${t.label}${t.turnaroundHours ? ` (${hoursLabel(t.turnaroundHours)})` : ''}: ${money(t.priceCents)}` }))} />
        <Checkbox label={`Add a cover letter (+${money(cfg.coverLetterCents)})`} checked={cover} onChange={e => setCover(e.target.checked)} />
      </div>
      <p className="mb-2 text-xs text-gray-500">{w.refunds}</p>
      <Input label="Target role" value={brief.targetRole} onChange={set('targetRole')} maxLength={200} />
      <Input label="Seniority" value={brief.seniority} onChange={set('seniority')} maxLength={100} />
      <Textarea label="Job posting (paste the text; the company name is hidden from the expert)" value={brief.jobPosting} onChange={set('jobPosting')} rows={5} maxLength={20000} hint="Optional, but it lets the expert tailor your keywords." />
      <Select label="Region and format" value={brief.region} onChange={set('region')}>{cfg.regions.map(r => <option key={r} value={r}>{r}</option>)}</Select>
      <Select label="Tone" value={brief.tone} onChange={set('tone')}>{cfg.tones.map(r => <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</option>)}</Select>
      <Textarea label="Things to keep or avoid" value={brief.keepAvoid} onChange={set('keepAvoid')} rows={2} maxLength={1000} />
      <Textarea label="Career story or gaps (optional)" value={brief.story} onChange={set('story')} rows={2} maxLength={2000} />
      <Textarea label="Anything the expert should know (optional)" value={brief.notes} onChange={set('notes')} rows={2} maxLength={2000} placeholder="For example: I am moving from teaching into product." />
      <fieldset className="mt-3"><legend className="font-medium text-gray-900">Top results with numbers (optional)</legend>
        {results.map((r, i) => (
          <div key={i} className="mt-2 grid gap-2 sm:grid-cols-3">
            <Input aria-label={`Result ${i + 1}: a result you are proud of`} placeholder="A result you are proud of" value={r.result} onChange={e => setResults(x => x.map((y, j) => j === i ? { ...y, result: e.target.value } : y))} />
            <Input aria-label={`Result ${i + 1}: the number behind it`} placeholder="The number behind it" value={r.number} onChange={e => setResults(x => x.map((y, j) => j === i ? { ...y, number: e.target.value } : y))} />
            <Input aria-label={`Result ${i + 1}: who can confirm it`} placeholder="Who can confirm it" value={r.confirmer} onChange={e => setResults(x => x.map((y, j) => j === i ? { ...y, confirmer: e.target.value } : y))} />
          </div>))}
      </fieldset>
      <p className="mt-4 text-sm text-gray-700">{w.privacy}</p>
      <div className="mt-2 space-y-1">
        <Checkbox label={w.termsConsent} checked={ticks.terms} onChange={e => setTicks(t => ({ ...t, terms: e.target.checked }))} />
        <Checkbox label={w.age} checked={ticks.age} onChange={e => setTicks(t => ({ ...t, age: e.target.checked }))} />
        <Checkbox label={w.rights} checked={ticks.rights} onChange={e => setTicks(t => ({ ...t, rights: e.target.checked }))} />
      </div>
      <div className="mt-3 rounded border border-dashed border-gray-300 p-2"><Checkbox label={`Optional: ${w.learning}`} checked={ticks.learning} onChange={e => setTicks(t => ({ ...t, learning: e.target.checked }))} /></div>
      <Button className="mt-4 w-full" size="lg" disabled={!ready} loading={busy} onClick={submit}>{chosen ? `Continue: ${money(total)}` : 'Choose how fast'}</Button>
      <p className="mt-2 text-xs text-gray-500">{w.terms}</p>
      <button type="button" className="mt-3 text-xs text-gray-400 hover:underline" onClick={() => navigate(-1)}>Back</button>
    </Page>
  )
}
function Page({ title, children }) { return <main className="mx-auto max-w-2xl px-4 py-8">{title && <h1 className="mb-4 text-2xl font-bold text-gray-900">{title}</h1>}{children}</main> }
