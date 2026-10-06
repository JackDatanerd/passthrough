import { useState } from 'react'
import ResumeFieldsForm from './ResumeFieldsForm'
import api, { getErrorMessage } from '../../lib/api'
import { downloadBlob } from '../../lib/utils'
import Button from '../ui/Button'
import Alert from '../ui/Alert'

// AUDIT FIX (feature gap — section audit "generate a resume from scratch"):
// this component closes the single biggest gap found in that audit. Before
// this existed, a brain-dump (or saved-profile) user's entire pipeline was a
// black box: paste text in, get a score out, with ZERO visibility into what
// Claude actually extracted — no preview, no way to correct a dropped job or
// a misread date, before that data became the basis for their score and, if
// they went on to pay, their delivered resume. getScan already returned
// scan.originalResumeData to the owner (scan.controller.js) from
// COMPLETE_PASS/COMPLETE_FAIL onward; nothing in the frontend ever rendered
// it. This does two things: shows it, and — via PATCH /scan/:id/resume-data
// — lets the person fix it and get an accurate rescore, before any money
// changes hands. It also surfaces the free draft download
// (GET /scan/:id/download-draft), since previously a brain-dump user who
// chose not to pay walked away with nothing tangible at all, despite the
// "Build & Score My Resume — Free" promise on the form that got them here.
//
// Only rendered by ScanResult for brain_dump/saved_profile scans that have
// finished their free scan and haven't had a fix purchased yet — see the
// call site for the exact gate, which mirrors the backend's own guard in
// updateResumeData/downloadDraft.
export default function ResumeDataEditor({ scan, anonToken, onUpdated }) {
  const [editing, setEditing] = useState(false)
  // Deep-cloned once, when editing starts — see "Edit" button below. Local
  // draft state, independent of the parent's `scan` prop, so half-finished
  // edits don't leak into the read-only summary until actually saved.
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [dlError, setDlError] = useState('')

  const data = scan.originalResumeData
  if (!data) return null

  function startEditing() {
    setDraft(JSON.parse(JSON.stringify(data)))
    setSaveError('')
    setEditing(true)
  }

  async function handleSave() {
    setSaving(true)
    setSaveError('')
    try {
      const url = `/scan/${scan.id}/resume-data${anonToken ? `?token=${anonToken}` : ''}`
      const res = await api.patch(url, { resumeData: draft })
      onUpdated(res.data.data)
      setEditing(false)
    } catch (err) {
      setSaveError(getErrorMessage(err, 'Could not save your changes — try again.'))
    }
    setSaving(false)
  }

  async function handleDownloadDraft() {
    setDlError('')
    try {
      const url = `/scan/${scan.id}/download-draft${anonToken ? `?token=${anonToken}` : ''}`
      const res = await api.get(url, { responseType: 'blob' })
      downloadBlob(res.data, 'resume-draft.docx')
    } catch (err) {
      setDlError(getErrorMessage(err, 'Could not download your draft — try again.'))
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 className="font-semibold text-gray-900">The resume we built from your text</h3>
          <p className="text-sm text-gray-500 mt-0.5">
            Review what we extracted before deciding anything — fix anything that's missing or wrong.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          {!editing && (
            <Button variant="secondary" size="sm" onClick={startEditing}>Review & edit</Button>
          )}
          <Button variant="secondary" size="sm" onClick={handleDownloadDraft}>
            Download draft (.docx)
          </Button>
        </div>
      </div>
      {dlError && <p className="text-xs text-red-600 mt-2">{dlError}</p>}

      {!editing ? (
        <ResumeDataSummary data={data} />
      ) : (
        <div className="mt-4 flex flex-col gap-5">
          <ResumeFieldsForm draft={draft} setDraft={setDraft} />

          <Alert>{saveError}</Alert>
          <div className="flex gap-3">
            <Button onClick={handleSave} loading={saving}>Save changes & rescore</Button>
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={saving}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  )
}

// Compact, non-editable view — the default state, so this doesn't turn every
// results page into a form by default. Deliberately not exhaustive (doesn't
// re-render every bullet) — just enough to sanity-check "did it get the
// shape of my background right" before deciding whether to dig into "Review
// & edit" or just move on.
function ResumeDataSummary({ data }) {
  const contactParts = [data.email, data.phone, data.location, data.linkedin, data.portfolio].filter(Boolean)
  return (
    <div className="mt-4 text-sm text-gray-700 flex flex-col gap-3">
      <div>
        <p className="font-medium text-gray-900">{data.name || <span className="italic text-gray-400">No name extracted</span>}</p>
        {contactParts.length > 0 && <p className="text-gray-500 text-xs mt-0.5">{contactParts.join(' · ')}</p>}
      </div>
      {data.experience?.length > 0 && (
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Experience ({data.experience.length})</p>
          <ul className="list-disc list-inside space-y-0.5">
            {data.experience.map((e, i) => (
              <li key={i}>{e.title || 'Untitled role'}{e.company ? ` at ${e.company}` : ''}{e.dates ? ` — ${e.dates}` : ''}</li>
            ))}
          </ul>
        </div>
      )}
      {data.education?.length > 0 && (
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Education ({data.education.length})</p>
          <ul className="list-disc list-inside space-y-0.5">
            {data.education.map((e, i) => (
              <li key={i}>{e.degree || 'Degree'}{e.institution ? ` — ${e.institution}` : ''}</li>
            ))}
          </ul>
        </div>
      )}
      {data.projects?.length > 0 && (
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Projects ({data.projects.length})</p>
          <ul className="list-disc list-inside space-y-0.5">
            {data.projects.map((p, i) => <li key={i}>{p.name || 'Untitled project'}</li>)}
          </ul>
        </div>
      )}
      {data.skills?.length > 0 && (
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Skills</p>
          <p>{data.skills.join(', ')}</p>
        </div>
      )}
      {!data.experience?.length && !data.education?.length && !data.projects?.length && !data.skills?.length && (
        <p className="text-amber-600 text-xs">
          We couldn't extract much structure from what you gave us — click "Review & edit" to fill in the gaps.
        </p>
      )}
    </div>
  )
}
