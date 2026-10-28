import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import Button from '../../components/ui/Button'
import Textarea from '../../components/ui/Textarea'
import Alert from '../../components/ui/Alert'
import Spinner from '../../components/ui/Spinner'
import { getErrorMessage } from '../../lib/api'
import { human, money } from '../../lib/humanApi'

// Experts Phase 1: the customer's orders. Status, the expert's questions, the delivered files, accept / one revision / rating / cancel.
export default function HumanOrders() {
  const [params] = useSearchParams(); const reference = params.get('reference') || params.get('trxref')
  const [orders, setOrders] = useState(null); const [open, setOpen] = useState(null); const [detail, setDetail] = useState(null)
  const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [text, setText] = useState(''); const [busy, setBusy] = useState(false)

  const load = useCallback(async () => { try { setOrders(await human.list()) } catch (e) { setErr(getErrorMessage(e, 'We could not load your orders.')); setOrders([]) } }, [])
  useEffect(() => { (async () => {
    if (reference) { try { await human.verify(reference); setMsg('Payment received. Your order is with us.') } catch (e) { setMsg('We are still confirming your payment. This page updates on its own.') } }
    await load()
  })() }, [reference, load])
  const openOrder = useCallback(async id => { setOpen(id); setDetail(null); setText(''); try { setDetail(await human.get(id)) } catch (e) { setErr(getErrorMessage(e, 'We could not load that order.')) } }, [])
  const act = async (fn, ok) => { setBusy(true); setErr(''); setMsg(''); try { await fn(); if (ok) setMsg(ok); await load(); if (open) setDetail(await human.get(open)) } catch (e) { setErr(getErrorMessage(e, 'That did not work. Please try again.')) } finally { setBusy(false) } }

  if (!orders) return <main className="mx-auto max-w-3xl px-4 py-8"><Spinner /></main>
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="mb-4 text-2xl font-bold text-gray-900">Your human rewrite orders</h1>
      {msg && <Alert variant="info" className="mb-3">{msg}</Alert>}
      {err && <Alert variant="error" className="mb-3">{err}</Alert>}
      {orders.length === 0 && <p className="text-sm text-gray-600">You have no human rewrite orders.</p>}
      <ul className="space-y-2">
        {orders.map(o => (
          <li key={o.id} className="rounded-lg border border-gray-200 bg-white p-3">
            <button type="button" className="flex w-full items-center justify-between text-left" onClick={() => openOrder(o.id)}>
              <span><b>{o.jobNumber}</b> <span className="text-sm text-gray-600">{o.tierLabel}{o.addCoverLetter ? ' + cover letter' : ''}</span></span>
              <span className="text-sm font-medium text-gray-800">{o.status}</span>
            </button>
            {open === o.id && (detail ? <Detail d={detail} busy={busy} text={text} setText={setText} act={act} /> : <Spinner />)}
          </li>))}
      </ul>
    </main>
  )
}

function Detail({ d, busy, text, setText, act }) {
  const q = (d.questions || []).find(x => x.status === 'pending')
  return (
    <div className="mt-3 space-y-3 border-t border-gray-100 pt-3 text-sm">
      <p className="text-gray-700">{money(d.priceCents)}{d.promisedAt ? ` \u00b7 expected by ${new Date(d.promisedAt).toLocaleString()}` : ''}{d.expert ? ` \u00b7 with ${d.expert}` : ''}</p>
      {d.state === 'awaiting_payment' && <p className="text-gray-600">This order has not been paid yet.</p>}
      {q && (
        <div className="rounded border border-amber-200 bg-amber-50 p-3">
          <p className="font-medium text-amber-900">The expert asks: {q.body}</p>
          <p className="text-xs text-amber-800">Your delivery clock is paused until you answer.</p>
          <Textarea aria-label="Your answer" rows={3} value={text} onChange={e => setText(e.target.value)} />
          <Button className="mt-2" disabled={!text.trim() || busy} onClick={() => act(() => human.answer(d.id, q.id, text.trim()), 'Thank you. The expert will carry on.')}>Send my answer</Button>
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
          {d.canAccept && <Button disabled={busy} onClick={() => act(() => human.accept(d.id), 'Accepted. Thank you.')}>Accept</Button>}
          {d.canRevise && (<><Textarea aria-label="What is not right" rows={2} placeholder="What is not right? (one revision is included)" value={text} onChange={e => setText(e.target.value)} />
            <Button variant="secondary" disabled={busy || text.trim().length < 3} onClick={() => act(() => human.revision(d.id, text.trim()), 'Sent. The expert will revise it.')}>Ask for the one revision</Button></>)}
        </div>)}
      {['delivered', 'accepted', 'revision'].includes(d.state) && !d.rated && (
        <div role="group" aria-label="Rate this order" className="flex items-center gap-1">Rate it:
          {[1, 2, 3, 4, 5].map(n => <button key={n} type="button" aria-label={`${n} star${n > 1 ? 's' : ''}`} className="rounded border px-2 py-0.5" onClick={() => act(() => human.rate(d.id, n), 'Thank you for rating.')}>{n}</button>)}
        </div>)}
      {d.canCancel && <Button variant="ghost" disabled={busy} onClick={() => act(() => human.cancel(d.id), 'Cancelled. Your refund is on its way.')}>Cancel for a full refund</Button>}
      <p className="text-xs text-gray-500">{d.wording?.refunds}</p>
    </div>
  )
}
