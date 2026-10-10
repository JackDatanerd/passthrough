import { useCallback, useEffect, useState } from 'react'
import api, { getErrorMessage } from '../../lib/api'
import Button from '../ui/Button'
import Input from '../ui/Input'
import Textarea from '../ui/Textarea'
import Checkbox from '../ui/Checkbox'
import { roleLabel } from '../../lib/roleCategories'
import { formatDate } from '../../lib/utils'

// "Did your resume lead to an interview?" — the question behind the homepage's interview rate, asked on
// the dashboard 14 days after a fix was delivered (the follow-up email links here a month after).
//
// Three answers, none privileged: "yes", "not yet", "still applying". An honest "not yet" is as useful as
// a "yes", and the copy says so; the form never nudges toward the flattering answer. Sharing a story is
// strictly optional, needs a ticked consent box, is reviewed before it appears, and can be taken back.
const STORY_LIMITS = { name: 40, quote: 160, text: 1200 }
const STATUS_TEXT = {
  PENDING:  'Waiting for review — it is not public yet.',
  APPROVED: 'Published on the homepage.',
  REJECTED: "We couldn't publish this one. You can edit and resubmit it from a new answer.",
}

function StoryForm({ scanId, onDone, onCancel, interview }) {
  const [displayName, setDisplayName] = useState('')
  const [quote, setQuote] = useState('')
  const [text, setText] = useState('')
  const [showCredential, setShowCredential] = useState(false)
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      await api.put('/outcomes', { scanId, outcome: 'INTERVIEW', ...interview, story: { consent, displayName, quote, text, showCredential } })
      onDone('Thank you! Your story is with our team for review — it is not public until we approve it.')
    } catch (err) {
      setError(getErrorMessage(err, "Couldn't submit your story."))
    } finally { setBusy(false) }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 mt-3 border-t border-gray-100 pt-3" noValidate>
      <Input label="Name to show" value={displayName} maxLength={STORY_LIMITS.name} onChange={e => setDisplayName(e.target.value)}
        hint='A first name and, if you like, an initial — e.g. "Amara O."' />
      <Input label="One-sentence headline" value={quote} maxLength={STORY_LIMITS.quote} onChange={e => setQuote(e.target.value)} />
      <Textarea label="Your story" rows={5} value={text} maxLength={STORY_LIMITS.text} onChange={e => setText(e.target.value)}
        hint={`What was happening, and what changed. ${text.length}/${STORY_LIMITS.text}. No links or contact details, please.`} />
      <Checkbox label="Link my Verified credential beside the story" description="Readers can open your verification page. Leave this off to keep it private."
        checked={showCredential} onChange={e => setShowCredential(e.target.checked)} />
      <Checkbox label="I'm happy for Passthrough to publish this on its website" description="We review every story first, and you can take yours down at any time."
        checked={consent} onChange={e => setConsent(e.target.checked)} />
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={busy} disabled={!consent}>Submit story</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Not now</Button>
      </div>
    </form>
  )
}

function Question({ item, onAnswered }) {
  const [step, setStep] = useState('ask')        // ask | interview | story
  const [count, setCount] = useState('')
  const [days, setDays] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const interviewDetails = () => ({
    ...(count !== '' ? { interviewCount: Number(count) } : {}),
    ...(days !== '' ? { interviewAfterDays: Number(days) } : {}),
  })

  async function send(outcome, extra = {}) {
    setBusy(true); setError('')
    try {
      await api.put('/outcomes', { scanId: item.scanId, outcome, ...extra })
      return true
    } catch (err) {
      setError(getErrorMessage(err, "Couldn't save your answer."))
      return false
    } finally { setBusy(false) }
  }

  async function answer(outcome) {
    if (await send(outcome)) onAnswered('Thank you — that genuinely helps.')
  }
  async function saveInterview() {
    if (await send('INTERVIEW', interviewDetails())) setStep('story')
  }

  return (
    <div className="rounded-lg border border-blue-100 bg-white p-4">
      <p className="text-sm text-gray-500 mb-1">
        {item.jobTitle ? `${item.jobTitle} · ` : ''}{item.roleCategory ? `${roleLabel(item.roleCategory)} · ` : ''}fixed resume delivered {formatDate(item.deliveredAt)}
      </p>
      {step === 'ask' && (
        <>
          <p className="font-semibold text-gray-900 mb-3">Did it lead to an interview?</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => setStep('interview')}>Yes, I got an interview</Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => answer('NO_INTERVIEW')}>Not yet</Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => answer('STILL_APPLYING')}>Still applying</Button>
          </div>
        </>
      )}
      {step === 'interview' && (
        <div className="flex flex-col gap-3">
          <p className="font-semibold text-gray-900">Great to hear! Two optional details:</p>
          <div className="grid sm:grid-cols-2 gap-3">
            <Input label="How many interviews?" type="number" min={1} max={99} inputMode="numeric" value={count} onChange={e => setCount(e.target.value)} />
            <Input label="Days after you received the resume" type="number" min={0} max={365} inputMode="numeric" value={days} onChange={e => setDays(e.target.value)} />
          </div>
          <div className="flex gap-2">
            <Button size="sm" loading={busy} onClick={saveInterview}>Continue</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setStep('ask')}>Back</Button>
          </div>
        </div>
      )}
      {step === 'story' && (
        <div>
          <p className="font-semibold text-gray-900">Thank you! Would you share your story?</p>
          <p className="text-sm text-gray-500 mt-1">Other applicants find real stories more convincing than anything we could write. It is optional, reviewed before it appears, and you can take it down any time.</p>
          <StoryForm scanId={item.scanId} interview={interviewDetails()}
            onDone={onAnswered} onCancel={() => onAnswered('Thank you — that genuinely helps.')} />
        </div>
      )}
      {error && step !== 'story' && <p role="alert" className="text-sm text-red-600 mt-2">{error}</p>}
    </div>
  )
}

export default function OutcomeCard() {
  const [state, setState] = useState(null)       // { pending, stories } | null (nothing to show / failed)
  const [note, setNote] = useState('')
  const [withdrawError, setWithdrawError] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await api.get('/outcomes/pending')
      setState(res.data.data)
    } catch (_) {
      setState(null)   // a dashboard extra: never an error banner, never blocks the scan list
    }
  }, [])
  useEffect(() => { load() }, [load])

  async function withdraw(scanId) {
    setWithdrawError('')
    try {
      await api.delete(`/outcomes/${encodeURIComponent(scanId)}/story`)
      setNote('Your story has been taken down.')
      load()
    } catch (err) {
      setWithdrawError(getErrorMessage(err, "Couldn't take the story down — please try again."))
    }
  }

  const pending = state?.pending || []
  const stories = state?.stories || []
  if (!pending.length && !stories.length && !note) return null

  return (
    <section id="outcome" aria-label="Tell us how it went" className="scroll-mt-4 rounded-xl border border-blue-200 bg-blue-50 p-5 flex flex-col gap-3">
      <div>
        <h2 className="font-semibold text-gray-900">How did it go?</h2>
        <p className="text-sm text-gray-600">An honest &ldquo;not yet&rdquo; helps us as much as a &ldquo;yes&rdquo; — it&apos;s how we find out what works, and it keeps the numbers we publish honest.</p>
      </div>
      {note && <p role="status" className="text-sm text-green-700">{note}</p>}
      {pending.map(item => (
        <Question key={item.scanId} item={item} onAnswered={(msg) => { setNote(msg); load() }} />
      ))}
      {stories.map(s => (
        <div key={s.scanId} className="rounded-lg border border-gray-200 bg-white p-4 text-sm">
          <p className="font-semibold text-gray-900">Your story{s.displayName ? ` as “${s.displayName}”` : ''}</p>
          {s.quote && <p className="text-gray-600 mt-0.5">“{s.quote}”</p>}
          <p className="text-gray-500 mt-1">{STATUS_TEXT[s.status] || ''}</p>
          <Button type="button" size="sm" variant="secondary" className="mt-2" onClick={() => withdraw(s.scanId)}>Take my story down</Button>
        </div>
      ))}
      {withdrawError && <p role="alert" className="text-sm text-red-600">{withdrawError}</p>}
    </section>
  )
}
