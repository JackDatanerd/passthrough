import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api, { getErrorMessage } from '../../lib/api'
import DashboardLayout from '../../components/layout/DashboardLayout'
import OutcomeCard, { StoryForm } from '../../components/account/OutcomeCard'
import Button from '../../components/ui/Button'
import Spinner from '../../components/ui/Spinner'
import ConfirmDialog from '../../components/ui/ConfirmDialog'
import { roleLabel } from '../../lib/roleCategories'
import { formatDate } from '../../lib/utils'

// Where the stories a person has shared are kept: what they wrote, where each one stands, and the two things they
// can do about it, edit it or take it down. Sharing is optional and always reviewed first; nothing appears on the
// homepage until it is approved, and a change to an approved story sends it back for review (the server enforces that).
const STATUS = {
  APPROVED: { label: 'Published', tone: 'bg-green-100 text-green-800', text: 'Live on the homepage.' },
  PENDING:  { label: 'In review', tone: 'bg-amber-100 text-amber-800', text: 'Our team is reading it. It is not public yet.' },
  REJECTED: { label: 'Not published', tone: 'bg-red-100 text-red-700', text: "We couldn't publish this one. Change it and resubmit, or take it down." },
}

function facts(story) {
  const parts = []
  if (story.roleCategory) parts.push(roleLabel(story.roleCategory))
  if (story.interviewCount) parts.push(`${story.interviewCount} interview${story.interviewCount === 1 ? '' : 's'}`)
  if (story.interviewAfterDays != null) parts.push(story.interviewAfterDays === 0 ? 'the same day it arrived' : `${story.interviewAfterDays} day${story.interviewAfterDays === 1 ? '' : 's'} after the resume arrived`)
  return parts
}

function StoryCard({ story, onChanged, onTakeDown }) {
  const [editing, setEditing] = useState(false)
  const st = STATUS[story.status] || STATUS.PENDING
  const detail = facts(story)
  // Only an interview the person has actually reported can carry a story, so these are what the form re-sends:
  // leaving them out would clear them (the server writes whatever the request holds).
  const interview = {
    ...(story.interviewCount != null ? { interviewCount: story.interviewCount } : {}),
    ...(story.interviewAfterDays != null ? { interviewAfterDays: story.interviewAfterDays } : {}),
  }

  return (
    <li className="rounded-xl border border-gray-200 bg-white p-5 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="font-semibold text-gray-900">{story.quote ? `“${story.quote}”` : 'Your story'}</p>
          <p className="text-xs text-gray-500 mt-0.5">
            {story.displayName ? `Shown as ${story.displayName}` : 'No name shown'} · shared {formatDate(story.answeredAt)}
          </p>
        </div>
        <span className={`rounded px-2 py-0.5 text-xs font-semibold ${st.tone}`}>{st.label}</span>
      </div>

      {editing ? (
        <div>
          {story.status === 'APPROVED' && (
            <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-1">
              If you change anything, the story goes back to review and comes off the homepage until we approve the new version.
            </p>
          )}
          <StoryForm scanId={story.scanId} interview={interview} initial={story}
            submitLabel="Save changes" cancelLabel="Cancel"
            onCancel={() => setEditing(false)}
            onDone={(_msg, result) => {
              setEditing(false)
              onChanged(result?.storyStatus === story.status && story.status === 'APPROVED'
                ? 'Nothing changed, so your story is still published.'
                : 'Saved. Your story is with our team for review and is not public until we approve it.')
            }} />
        </div>
      ) : (
        <>
          {story.text && <p className="text-sm text-gray-700 whitespace-pre-line">{story.text}</p>}
          {detail.length > 0 && <p className="text-xs text-gray-500">{detail.join(' · ')}</p>}
          <p className="text-xs text-gray-500">
            {story.showCredential ? 'Your Verified link is shown beside the story.' : 'Your Verified link is not shown.'}
          </p>
          <p className="text-sm text-gray-600">{st.text}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>Edit story</Button>
            <Button size="sm" variant="secondary" onClick={() => onTakeDown(story)}>Take it down</Button>
            {story.status === 'APPROVED' && <Link to="/#stories" className="px-3 py-1.5 text-sm text-blue-700 hover:text-blue-900">See it on the homepage</Link>}
          </div>
        </>
      )}
    </li>
  )
}

export default function MyStory() {
  const [stories, setStories] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [note, setNote] = useState('')
  const [actionError, setActionError] = useState('')
  const [pendingTakeDown, setPendingTakeDown] = useState(null)
  const [busy, setBusy] = useState(false)
  // Bumping this re-reads the question prompt above the list (an answer there can create a story).
  const [promptKey, setPromptKey] = useState(0)

  const load = useCallback(async () => {
    setLoadError('')
    try {
      const res = await api.get('/outcomes/mine')
      setStories(res.data.data.stories || [])
    } catch (err) {
      setLoadError(getErrorMessage(err, "Couldn't load your stories."))
    }
  }, [])
  useEffect(() => { load() }, [load])

  async function confirmTakeDown() {
    setBusy(true); setActionError('')
    try {
      await api.delete(`/outcomes/${encodeURIComponent(pendingTakeDown.scanId)}/story`)
      setNote('Your story has been taken down.')
      setPendingTakeDown(null)
      load()
    } catch (err) {
      setPendingTakeDown(null)
      if (err.response?.status === 404) { load() }   // already gone (another tab): the goal is met
      else setActionError(getErrorMessage(err, "Couldn't take the story down. Please try again."))
    } finally { setBusy(false) }
  }

  return (
    <DashboardLayout>
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">My Story</h1>
          <p className="text-sm text-gray-600 mt-1">
            Other applicants trust real stories more than anything we could write. Yours stays optional: we read every one before it appears, it never shows your email or contact details, and you can take it down whenever you like.
          </p>
        </div>

        {/* "Did it lead to an interview?" for fixes delivered 14+ days ago. Answering yes is how a story starts. */}
        <OutcomeCard key={promptKey} showStories={false} />

        {note && <p role="status" className="text-sm text-green-700">{note}</p>}
        {actionError && <p role="alert" className="text-sm text-red-600">{actionError}</p>}

        {!stories && !loadError && <div className="flex justify-center py-12"><Spinner size="lg" /></div>}

        {loadError && (
          <div role="alert" className="text-center py-12 border border-red-200 bg-red-50 rounded-xl">
            <p className="text-sm text-red-700 mb-4">{loadError}</p>
            <Button size="sm" variant="secondary" onClick={load}>Try again</Button>
          </div>
        )}

        {stories && stories.length === 0 && (
          <div className="rounded-xl border border-dashed border-gray-200 p-8 text-center">
            <p className="text-gray-600">No stories yet.</p>
            <p className="text-sm text-gray-500 mt-1">When a fixed resume leads to an interview, you can tell us about it here. We ask 14 days after your fix arrives.</p>
            <Link to="/dashboard" className="inline-block mt-3 text-sm text-blue-700 hover:text-blue-900">Back to your scans</Link>
          </div>
        )}

        {stories && stories.length > 0 && (
          <ul className="flex flex-col gap-4" aria-label="Your stories">
            {stories.map(s => (
              <StoryCard key={s.scanId} story={s}
                onChanged={msg => { setNote(msg); setPromptKey(k => k + 1); load() }}
                onTakeDown={story => { setActionError(''); setPendingTakeDown(story) }} />
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={!!pendingTakeDown}
        title="Take your story down"
        message={'Your story comes off the homepage and its text is deleted from our side. Your interview answer stays, anonymously, in the numbers we publish. You can share a new story later.'}
        confirmLabel="Take it down"
        loading={busy}
        onConfirm={confirmTakeDown}
        onCancel={() => setPendingTakeDown(null)}
      />
    </DashboardLayout>
  )
}
