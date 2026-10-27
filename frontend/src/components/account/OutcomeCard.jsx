import { useCallback, useEffect, useState } from 'react'
import api, { getErrorMessage } from '../../lib/api'
import Button from '../ui/Button'
import Input from '../ui/Input'
import Textarea from '../ui/Textarea'
import Checkbox from '../ui/Checkbox'
import { roleLabel } from '../../lib/roleCategories'
import { formatDate } from '../../lib/utils'

// "Did your resume lead to an interview?" — the question behind the homepage's interview rate, asked on
// the dashboard and the My Story tab 14 days after a fix was first delivered (the follow-up email, a month after, links to My Story).
//
// Three answers, none privileged: "yes", "not yet", "still applying". An honest "not yet" is as useful as
// a "yes", and the copy says so; the form never nudges toward the flattering answer. Sharing a story is
// strictly optional, needs a ticked consent box, is reviewed before it appears, and can be taken back.
//
// An answer is never final: "still applying" is asked again 30 days later, and every answer given is listed on the My Story tab
// (`showAnswers`) with a button to change it — someone who said "not yet" and then got the call can say so.
const STORY_LIMITS = { name: 40, quote: 160, text: 1200 }
const ANSWER_TEXT = { INTERVIEW: 'Yes, I got an interview', NO_INTERVIEW: 'Not yet', STILL_APPLYING: 'Still applying' }
const STATUS_TEXT = {
  PENDING:  'Waiting for review — it is not public yet.',
  APPROVED: 'Published on the homepage.',
  REJECTED: "We couldn't publish this one. You can edit and resubmit it from a new answer.",
}

// Used here for a first story, and by the My Story tab (with `initial`) to edit one that already exists. An existing
// story has already been consented to, so editing starts with the box ticked; the server still requires it.
export function StoryForm({ scanId, onDone, onCancel, interview, initial, submitLabel = 'Submit story', cancelLabel = 'Not now' }) {
  const [displayName, setDisplayName] = useState(initial?.displayName ?? '')
  const [quote, setQuote] = useState(initial?.quote ?? '')
  const [text, setText] = useState(initial?.text ?? '')
  const [showCredential, setShowCredential] = useState(initial?.showCredential ?? false)
  const [consent, setConsent] = useState(!!initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const res = await api.put('/outcomes', { scanId, outcome: 'INTERVIEW', ...interview, story: { consent, displayName, quote, text, showCredential } })
      onDone('Thank you! Your story is with our team for review — it is not public until we approve it.', res?.data?.data)
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
        <Button type="submit" size="sm" loading={busy} disabled={!consent}>{submitLabel}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>{cancelLabel}</Button>
      </div>
    </form>
  )
}

// `current` (an outcome) is set when the person is changing an answer they already gave: that option is not offered again.
function Question({ item, onAnswered, current = null }) {
  const [step, setStep] = useState('ask')        // ask | saved
  const [count, setCount] = useState('')
  const [days, setDays] = useState('')
  const [detailsSaved, setDetailsSaved] = useState(false)
  const [showStory, setShowStory] = useState(false)
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
  // "Yes" is saved the moment it is tapped: the answer is what the homepage number is built from, so it must count even if the person
  // never touches the optional parts below. The card stays on screen (the parent reloads only when they finish), so those parts are
  // still there for anyone who wants them.
  async function yes() {
    if (await send('INTERVIEW')) setStep('saved')
  }
  async function saveDetails() {
    setDetailsSaved(false)
    if (await send('INTERVIEW', interviewDetails())) setDetailsSaved(true)
  }

  return (
    <div className="rounded-lg border border-blue-100 bg-white p-4">
      <p className="text-sm text-gray-500 mb-1">
        {item.jobTitle ? `${item.jobTitle} · ` : ''}{item.roleCategory ? `${roleLabel(item.roleCategory)} · ` : ''}{item.fixTier === 'BADGE' ? 'Verified credential' : 'fixed resume'} delivered {formatDate(item.deliveredAt)}
      </p>
      {step === 'ask' && (
        <>
          <p className="font-semibold text-gray-900 mb-3">
            {item.reask ? 'You told us you were still applying. Any news?' : current ? 'What is the answer now?' : (item.fixTier === 'BADGE' ? 'Did your credential lead to an interview?' : 'Did it lead to an interview?')}
          </p>
          <div className="flex flex-wrap gap-2">
            {current !== 'INTERVIEW' && <Button size="sm" pending={busy} onClick={yes}>Yes, I got an interview</Button>}
            {current !== 'NO_INTERVIEW' && <Button size="sm" variant="secondary" pending={busy} onClick={() => answer('NO_INTERVIEW')}>Not yet</Button>}
            {current !== 'STILL_APPLYING' && <Button size="sm" variant="secondary" pending={busy} onClick={() => answer('STILL_APPLYING')}>Still applying</Button>}
          </div>
        </>
      )}
      {step === 'saved' && (
        <div className="flex flex-col gap-4">
          <p role="status" className="font-semibold text-green-700">✓ Saved. Great to hear, and thank you.</p>

          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium text-gray-900">Optional: a little more detail</p>
            <div className="grid sm:grid-cols-2 gap-3">
              <Input label="How many interviews?" type="number" min={1} max={99} inputMode="numeric" value={count} onChange={e => { setCount(e.target.value); setDetailsSaved(false) }} />
              <Input label="Days after you received the resume" type="number" min={0} max={365} inputMode="numeric" value={days} onChange={e => { setDays(e.target.value); setDetailsSaved(false) }} />
            </div>
            <div className="flex items-center gap-3">
              <Button size="sm" variant="secondary" loading={busy && !showStory} disabled={count === '' && days === ''} onClick={saveDetails}>Save details</Button>
              <span aria-live="polite" className="text-sm text-green-700">{detailsSaved ? 'Details saved.' : ''}</span>
            </div>
          </div>

          {!showStory ? (
            <div>
              <p className="text-sm font-medium text-gray-900">Would you share your story?</p>
              <p className="text-sm text-gray-500 mt-1">Other applicants find real stories more convincing than anything we could write. It is optional, reviewed before it appears, and you can take it down at any time.</p>
              <Button size="sm" variant="secondary" className="mt-2" onClick={() => setShowStory(true)}>Share my story</Button>
            </div>
          ) : (
            <StoryForm scanId={item.scanId} interview={interviewDetails()}
              onDone={onAnswered} onCancel={() => setShowStory(false)} />
          )}

          <div>
            <Button size="sm" pending={busy} onClick={() => onAnswered('Thank you — that genuinely helps.')}>Done</Button>
          </div>
        </div>
      )}
      {error && !showStory && <p role="alert" className="text-sm text-red-600 mt-2">{error}</p>}
    </div>
  )
}

// One answer already given, with the way back in: "Change my answer" opens the same question. Moving away from "yes" ends a story
// that was shared with it (the server enforces that), so the person is told before they do it.
function AnswerRow({ answer, onChanged }) {
  const [changing, setChanging] = useState(false)
  const hasStory = answer.storyStatus && answer.storyStatus !== 'NONE'
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 text-sm">
      <p className="text-gray-500">
        {answer.jobTitle ? `${answer.jobTitle} · ` : ''}{answer.roleCategory ? `${roleLabel(answer.roleCategory)} · ` : ''}delivered {formatDate(answer.deliveredAt)}
      </p>
      <p className="font-semibold text-gray-900 mt-0.5">You told us: {ANSWER_TEXT[answer.outcome] || answer.outcome}</p>
      {!changing ? (
        <Button type="button" size="sm" variant="secondary" className="mt-2" onClick={() => setChanging(true)}>Change my answer</Button>
      ) : (
        <div className="mt-3">
          {answer.outcome === 'INTERVIEW' && hasStory && (
            <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
              Changing this answer away from “yes” takes the story you shared down, because it would no longer be true.
            </p>
          )}
          <Question item={{ scanId: answer.scanId, jobTitle: answer.jobTitle, roleCategory: answer.roleCategory, fixTier: answer.fixTier, deliveredAt: answer.deliveredAt }}
            current={answer.outcome} onAnswered={(msg) => { setChanging(false); onChanged(msg) }} />
          <Button type="button" size="sm" variant="ghost" className="mt-2" onClick={() => setChanging(false)}>Cancel</Button>
        </div>
      )}
    </div>
  )
}

// `showStories` lists the person's existing stories under the question. The My Story tab owns that list now, so the
// dashboard pages turn it off and keep only the question.
// `onAnswered` lets the page around the card re-read what it shows (an answer can end or start a story).
export default function OutcomeCard({ showStories = true, showAnswers = false, onAnswered }) {
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
  const stories = showStories ? (state?.stories || []) : []
  const answers = showAnswers ? (state?.answers || []) : []
  if (!pending.length && !stories.length && !answers.length && !note) return null

  return (
    <section id="outcome" aria-label="Tell us how it went" className="scroll-mt-4 rounded-xl border border-blue-200 bg-blue-50 p-5 flex flex-col gap-3">
      <div>
        <h2 className="font-semibold text-gray-900">How did it go?</h2>
        <p className="text-sm text-gray-600">An honest &ldquo;not yet&rdquo; helps us as much as a &ldquo;yes&rdquo; — it&apos;s how we find out what works, and it keeps the numbers we publish honest.</p>
      </div>
      {note && <p role="status" className="text-sm text-green-700">{note}</p>}
      {pending.map(item => (
        <Question key={item.scanId} item={item} onAnswered={(msg) => { setNote(msg); load(); onAnswered?.() }} />
      ))}
      {answers.length > 0 && (
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-gray-900">Your answers</h3>
          {answers.map(a => <AnswerRow key={a.scanId} answer={a} onChanged={(msg) => { setNote(msg); load(); onAnswered?.() }} />)}
        </div>
      )}
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
