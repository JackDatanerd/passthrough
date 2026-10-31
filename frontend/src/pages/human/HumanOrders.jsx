import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import Button from '../../components/ui/Button'
import Input from '../../components/ui/Input'
import Textarea from '../../components/ui/Textarea'
import Alert from '../../components/ui/Alert'
import Spinner from '../../components/ui/Spinner'
import { getErrorMessage } from '../../lib/api'
import { human, money } from '../../lib/humanApi'
import { classifyVerify, PENDING_MAX_ATTEMPTS, PENDING_RETRY_MS, ERROR_RETRY_MS, ERROR_MAX_RETRIES, RATE_RETRY_MS, TERMINAL_STATES } from '../../lib/humanPaymentCheck'
import OrderTracker from '../../components/human/OrderTracker'

// How often the page looks for news while an order is still moving (an expert's question, a delivery). Slow on purpose: the account's request
// limit is shared with everything else done on an order. It does not run while the tab is hidden.
const REFRESH_MS = 60000

const CHECK_TEXT = {
  checking: 'Checking your payment\u2026',
  paid: 'Payment received. Your order is with us.',
  pending: 'Your payment is still being confirmed. This can take a few minutes; we are checking again.',
  slow: 'Your payment is still being confirmed. We will email you as soon as it is. You can check again now.',
  error: 'We could not check your payment just now. You can check again.',
}

// Experts Phase 1: the customer's orders. Status, the expert's questions, the delivered files, accept / one revision / rating / cancel.
export default function HumanOrders() {
  const [params] = useSearchParams(); const reference = params.get('reference') || params.get('trxref'); const wanted = params.get('order')
  const [orders, setOrders] = useState(null); const [loadFailed, setLoadFailed] = useState(false); const [open, setOpen] = useState(null); const [detail, setDetail] = useState(null)
  const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false)
  const [check, setCheck] = useState(reference ? { kind: 'checking', message: '' } : null); const [again, setAgain] = useState(0)
  const openRef = useRef(null); openRef.current = open
  const wantedDone = useRef(false)

  const load = useCallback(async () => {
    try { setOrders(await human.list()); setLoadFailed(false) } catch (e) { setErr(getErrorMessage(e, 'We could not load your orders.')); setLoadFailed(true); setOrders(x => x || []) }
  }, [])
  const openOrder = useCallback(async id => { setOpen(id); setDetail(null); try { setDetail(await human.get(id)) } catch (e) { setErr(getErrorMessage(e, 'We could not load that order.')) } }, [])
  // quiet refresh: no spinner, no error banner; a failure is simply tried again at the next tick
  const refresh = useCallback(async () => {
    try { const list = await human.list(); setOrders(list); setLoadFailed(false); if (openRef.current) setDetail(await human.get(openRef.current)) } catch (_) { /* next tick */ }
  }, [])

  // The return from Paystack: say what actually happened. Pending is polled, a definite failure is stated, a delay is only called a delay.
  useEffect(() => {
    if (!reference) return undefined
    let off = false; let timer = null; let attempt = 0; let errors = 0; let rate = 0
    const run = async () => {
      attempt += 1
      let out
      try { out = classifyVerify({ body: await human.verify(reference) }) } catch (e) { out = classifyVerify({ err: e }) }
      if (off) return
      if (out.kind === 'pending' && attempt >= PENDING_MAX_ATTEMPTS) out = { ...out, slow: true }
      setCheck(out)
      if (out.kind === 'paid' || out.kind === 'refunded' || out.kind === 'disputed') { await load(); return }
      if (out.kind === 'pending' && attempt < PENDING_MAX_ATTEMPTS) timer = setTimeout(run, PENDING_RETRY_MS)
      else if (out.kind === 'error' && errors < ERROR_MAX_RETRIES) { errors += 1; timer = setTimeout(run, ERROR_RETRY_MS) }
      else if (out.kind === 'rate-limited' && rate < 2) { rate += 1; timer = setTimeout(run, RATE_RETRY_MS) }
    }
    setCheck({ kind: 'checking', message: '' }); run()
    return () => { off = true; clearTimeout(timer) }
  }, [reference, again, load])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (wanted && orders && !wantedDone.current && orders.some(o => o.id === wanted)) { wantedDone.current = true; openOrder(wanted) } }, [wanted, orders, openOrder])

  // keep the page current while any order can still change, and again when the person comes back to the tab
  const moving = !!orders && orders.some(o => !TERMINAL_STATES.includes(o.state))
  useEffect(() => {
    if (!moving) return undefined
    const tick = () => { if (typeof document === 'undefined' || !document.hidden) refresh() }
    const id = setInterval(tick, REFRESH_MS)
    document.addEventListener('visibilitychange', tick)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick) }
  }, [moving, refresh])

  const act = async (fn, ok) => { setBusy(true); setErr(''); setMsg(''); try { await fn(); if (ok) setMsg(ok); await load(); if (openRef.current) setDetail(await human.get(openRef.current)) } catch (e) { setErr(getErrorMessage(e, 'That did not work. Please try again.')) } finally { setBusy(false) } }
  const payNow = async id => { setBusy(true); setErr(''); try { const d = await human.pay(id); if (d?.authorizationUrl) window.location.assign(d.authorizationUrl); else setErr('Payment could not be opened. Please try again.') } catch (e) { setErr(getErrorMessage(e, 'Payment could not be opened. Please try again.')) } finally { setBusy(false) } }

  const checkMessage = !check ? '' : check.kind === 'pending' ? (check.slow ? CHECK_TEXT.slow : CHECK_TEXT.pending)
    : ['failed', 'support', 'refunded', 'disputed', 'session', 'rate-limited'].includes(check.kind) ? check.message : CHECK_TEXT[check.kind] || ''
  const checkBad = !!check && ['failed', 'support', 'refunded', 'disputed', 'session'].includes(check.kind)
  const canRecheck = !!check && (check.slow || ['error', 'rate-limited'].includes(check.kind))

  if (!orders) return <main className="mx-auto max-w-3xl px-4 py-8"><Spinner /></main>
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="mb-4 text-2xl font-bold text-gray-900">Your human rewrite orders</h1>
      {checkMessage && (
        <Alert variant={checkBad ? 'error' : 'info'} className="mb-3">
          {checkMessage}{canRecheck && <> <button type="button" className="font-medium underline" onClick={() => setAgain(n => n + 1)}>Check again</button></>}
        </Alert>)}
      {msg && <Alert variant="info" className="mb-3">{msg}</Alert>}
      {err && <Alert variant="error" className="mb-3">{err}</Alert>}
      {orders.length === 0 && !loadFailed && <p className="text-sm text-gray-600">You have no human rewrite orders.</p>}
      <ul className="space-y-2">
        {orders.map(o => (
          <li key={o.id} className="rounded-lg border border-gray-200 bg-white p-3">
            <button type="button" className="flex w-full items-center justify-between text-left" onClick={() => openOrder(o.id)}>
              <span><b>{o.jobNumber}</b> <span className="text-sm text-gray-600">{o.tierLabel}{o.addCoverLetter ? ' + cover letter' : ''}</span></span>
              <span className="text-sm font-medium text-gray-800">{o.status}</span>
            </button>
            {open === o.id && (detail ? <Detail key={detail.id} d={detail} busy={busy} act={act} payNow={payNow} /> : <Spinner />)}
          </li>))}
      </ul>
    </main>
  )
}

// A one-click action that cannot be undone asks once more, in words that say what it does.
function Confirm({ text, yes, no, busy, onYes, onNo }) {
  return (
    <div role="alertdialog" aria-label="Please confirm" className="rounded border border-gray-300 bg-gray-50 p-3">
      <p className="text-gray-900">{text}</p>
      <div className="mt-2 flex flex-wrap gap-2"><Button disabled={busy} onClick={onYes}>{yes}</Button><Button variant="secondary" disabled={busy} onClick={onNo}>{no}</Button></div>
    </div>
  )
}

function Detail({ d, busy, act, payNow }) {
  const [answer, setAnswer] = useState(''); const [reason, setReason] = useState(''); const [link, setLink] = useState(''); const [confirming, setConfirming] = useState(null)
  const q = (d.questions || []).find(x => x.status === 'pending')
  const done = fn => { setConfirming(null); return fn() }
  return (
    <div className="mt-3 space-y-3 border-t border-gray-100 pt-3 text-sm">
      <OrderTracker order={d} />
      <p className="text-gray-700">{money(d.priceCents)}{d.expert ? ` \u00b7 with ${d.expert}` : ''}</p>
      {d.state === 'awaiting_payment' && (
        <div className="space-y-2">
          <p className="text-gray-600">This order has not been paid yet.</p>
          <Button disabled={busy} onClick={() => payNow(d.id)}>Pay {money(d.priceCents)} now</Button>
        </div>)}
      {d.canEditMaterials && (
        <div className="rounded border border-gray-200 p-3">
          <p className="font-medium text-gray-900">Supporting materials</p>
          <p className="text-xs text-gray-500">You can add or remove these until an expert takes your order.</p>
          {(d.materials || []).length > 0 && (
            <ul className="mt-2 space-y-1">
              {d.materials.map(m => (
                <li key={m.id} className="flex items-center justify-between gap-2"><span className="truncate">{m.kind === 'link' ? (m.url || m.label) : m.label}</span>
                  <Button variant="ghost" disabled={busy} aria-label={`Remove ${m.label || 'this item'}`} onClick={() => act(() => human.removeMaterial(d.id, m.id), 'Removed.')}>Remove</Button></li>))}
            </ul>)}
          <input type="file" accept=".pdf,.docx" aria-label="Add a file" className="mt-2 block text-sm" disabled={busy}
            onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) act(() => human.upload(d.id, f), 'File added.') }} />
          <div className="mt-2 flex gap-2"><Input aria-label="Add a link" placeholder="https://" value={link} onChange={e => setLink(e.target.value)} />
            <Button variant="secondary" disabled={busy || !link.trim()} onClick={() => act(async () => { await human.addLink(d.id, link.trim()); setLink('') }, 'Link added.')}>Add link</Button></div>
        </div>)}
      {q && (
        <div className="rounded border border-amber-200 bg-amber-50 p-3">
          <p className="font-medium text-amber-900">The expert asks: {q.body}</p>
          <p className="text-xs text-amber-800">Your delivery clock is paused until you answer.</p>
          <Textarea aria-label="Your answer" rows={3} value={answer} onChange={e => setAnswer(e.target.value)} />
          <Button className="mt-2" disabled={!answer.trim() || busy} onClick={() => act(() => human.answer(d.id, q.id, answer.trim()), 'Thank you. The expert will carry on.')}>Send my answer</Button>
        </div>)}
      {(d.questions || []).filter(x => x.status !== 'pending').map(x => <p key={x.id} className="text-gray-600"><b>Q:</b> {x.body} <b>A:</b> {x.answer || '(not answered in time)'}</p>)}
      {d.delivery && (
        <div className="rounded border border-green-200 bg-green-50 p-3">
          <p className="font-medium text-green-900">Delivered{d.delivery.scoreAfter != null && d.delivery.scoreBefore != null ? `: ATS score ${d.delivery.scoreBefore} \u2192 ${d.delivery.scoreAfter}` : ''}</p>
          {d.delivery.summary && <p className="text-green-900">{d.delivery.summary}</p>}
          {d.delivery.confirmations.length > 0 && <p className="mt-1 text-xs text-green-900">Please check these figures are right: {d.delivery.confirmations.map(c => c.text).join(', ')}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            {d.delivery.files.docx && <Button variant="secondary" onClick={() => act(() => human.download(d.id, 'docx'))}>Download Word</Button>}
            {d.delivery.files.pdf && <Button variant="secondary" onClick={() => act(() => human.download(d.id, 'pdf'))}>Download PDF</Button>}
            {d.delivery.files.cover && <Button variant="secondary" onClick={() => act(() => human.download(d.id, 'cover'))}>Cover letter</Button>}
          </div>
        </div>)}
      {d.canAccept && d.autoAcceptAt && <p className="text-xs text-gray-500">If you do nothing, this order is accepted automatically on {new Date(d.autoAcceptAt).toLocaleString()}.</p>}
      {(d.canAccept || d.canRevise) && (
        <div className="space-y-2">
          {d.canAccept && confirming !== 'accept' && <Button disabled={busy} onClick={() => setConfirming('accept')}>Accept</Button>}
          {confirming === 'accept' && <Confirm busy={busy} text={`Accept this delivery? This finishes the order${d.canRevise ? ' and uses up your one included revision' : ''}. It cannot be undone.`} yes="Yes, accept" no="Not yet" onNo={() => setConfirming(null)} onYes={() => done(() => act(() => human.accept(d.id), 'Accepted. Thank you.'))} />}
          {d.canRevise && (<><Textarea aria-label="What is not right" rows={2} placeholder="What is not right? (one revision is included)" value={reason} onChange={e => setReason(e.target.value)} />
            <Button variant="secondary" disabled={busy || reason.trim().length < 3} onClick={() => act(() => human.revision(d.id, reason.trim()), 'Sent. The expert will revise it.')}>Ask for the one revision</Button></>)}
        </div>)}
      {['delivered', 'accepted', 'revision'].includes(d.state) && !d.rated && (
        <div role="group" aria-label="Rate this order" className="flex items-center gap-1">Rate it:
          {[1, 2, 3, 4, 5].map(n => <button key={n} type="button" aria-label={`${n} star${n > 1 ? 's' : ''}`} className="rounded border px-2 py-0.5" onClick={() => act(() => human.rate(d.id, n), 'Thank you for rating.')}>{n}</button>)}
        </div>)}
      {d.canCancel && confirming !== 'cancel' && <Button variant="ghost" disabled={busy} onClick={() => setConfirming('cancel')}>Cancel for a full refund</Button>}
      {confirming === 'cancel' && <Confirm busy={busy} text="Cancel this order? It closes now and your full payment is refunded. This cannot be undone." yes="Yes, cancel and refund" no="Keep my order" onNo={() => setConfirming(null)} onYes={() => done(() => act(() => human.cancel(d.id), 'Cancelled. Your refund is on its way.'))} />}
      <p className="text-xs text-gray-500">{d.wording?.refunds}</p>
    </div>
  )
}
