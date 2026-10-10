import { useState } from 'react'
import api, { getErrorMessage } from '../../lib/api'
import Button from '../ui/Button'
import Alert from '../ui/Alert'

// Phase 3 — Claude's rewriteResumeContent flags bullets that describe an outcome or improvement where a number would
// strengthen the line, but where the user didn't provide one — rather than inventing a metric (which the prompt
// explicitly forbids), it surfaces the gap here for the user to fill in themselves.
//
// SCAN/ATS ROUND 4: these used to be plain text with "use Edit your delivered resume below" — the person had to find the
// bullet again in a separate editor. Each prompt now has an "Add my number" field right where the suggestion is: it edits
// that one bullet and saves through the same delivered-resume endpoint (both files rebuilt and re-scored; the prompt
// disappears once its bullet changes). Shown only to the signed-in owner; everyone else still sees the suggestion.
//
// Renders nothing if there are no prompts — this is the common case for well-quantified resumes, and for badge-only
// purchases (which never run the AI rewrite, so quantificationPrompts is always empty/null there).

// Replaces the first experience bullet equal to `from` (ignoring surrounding whitespace). Returns null if it is gone.
export function replaceBullet(resumeData, from, to) {
  if (!resumeData || !Array.isArray(resumeData.experience)) return null
  const copy = JSON.parse(JSON.stringify(resumeData))
  const want = String(from || '').trim()
  for (const job of copy.experience) {
    if (!Array.isArray(job?.bullets)) continue
    const i = job.bullets.findIndex(b => typeof b === 'string' && b.trim() === want)
    if (i !== -1) { job.bullets[i] = to; return copy }
  }
  return null
}

function PromptRow({ prompt, scan, onSaved }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(prompt.bullet)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const trimmed = text.trim()
  const unchanged = trimmed === String(prompt.bullet || '').trim()

  async function save() {
    const next = replaceBullet(scan.rewrittenResumeData, prompt.bullet, trimmed)
    if (!next) { setError('That line has changed since this page loaded — refresh and try again.'); return }
    setSaving(true); setError('')
    try {
      const res = await api.patch(`/scan/${scan.id}/delivered-resume`, { resumeData: next })
      await onSaved(res.data.data)
    } catch (err) {
      setError(getErrorMessage(err, 'Could not save that change — try again.'))
      setSaving(false)
    }
  }

  return (
    <li className="border-l-2 border-amber-200 pl-3" data-testid="quant-prompt">
      <p className="text-sm text-gray-800">{prompt.bullet}</p>
      <p className="text-xs text-amber-700 mt-0.5">{prompt.suggestion}</p>
      {onSaved && !editing && (
        <button type="button" onClick={() => setEditing(true)} className="mt-1 text-xs text-blue-600 hover:underline">
          Add my number
        </button>
      )}
      {onSaved && editing && (
        <div className="mt-2 flex flex-col gap-2">
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            rows={2}
            maxLength={400}
            aria-label="Edit this bullet"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {trimmed && !/\d/.test(trimmed) && (
            <p className="text-xs text-gray-500">Include the figure itself — for example "by 30%", "for 12 clients" or "in 2 weeks".</p>
          )}
          <Alert>{error}</Alert>
          <div className="flex gap-2">
            <Button size="sm" onClick={save} loading={saving} disabled={!trimmed || unchanged}>Save and rebuild</Button>
            <Button size="sm" variant="secondary" onClick={() => { setEditing(false); setText(prompt.bullet); setError('') }} disabled={saving}>Cancel</Button>
          </div>
        </div>
      )}
    </li>
  )
}

export default function QuantificationPrompts({ prompts, scan = null, onSaved = null }) {
  if (!prompts || prompts.length === 0) return null
  const canEdit = !!(scan && onSaved && scan.rewrittenResumeData)

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
      <p className="text-sm font-semibold text-gray-900 mb-1">Strengthen these lines</p>
      <p className="text-xs text-gray-500 mb-4">
        These bullets could be more persuasive with a specific number — we won't invent one,
        {canEdit
          ? ' but if you have it, add it right here — both files are rebuilt and re-checked.'
          : ' but if you have it, use "Edit your delivered resume" below to add it — both files are rebuilt and re-checked.'}
      </p>
      <ul className="flex flex-col gap-3">
        {prompts.map((p, i) => <PromptRow key={`${i}-${p.bullet}`} prompt={p} scan={canEdit ? scan : null} onSaved={canEdit ? onSaved : null} />)}
      </ul>
    </div>
  )
}
