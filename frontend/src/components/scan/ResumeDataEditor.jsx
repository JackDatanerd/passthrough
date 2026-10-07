import { useState } from 'react'
import ResumeFieldsForm from './ResumeFieldsForm'
import api, { getErrorMessage } from '../../lib/api'
import { downloadBlob } from '../../lib/utils'
import Button from '../ui/Button'
import Alert from '../ui/Alert'
import { missingHints } from '../../lib/resumeForm'

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
  const [pdfLoading, setPdfLoading] = useState(false)
  const [structuring, setStructuring] = useState(false)
  const [structError, setStructError] = useState('')

  const data = scan.originalResumeData
  const isFile = scan.inputMode === 'file'

  // An UPLOADED file is only structured when asked (one Claude call): the same structure the paid
  // job would otherwise build later, where a misreading is first seen on a delivered, paid file.
  async function handleStructure() {
    setStructuring(true)
    setStructError('')
    try {
      const url = `/scan/${scan.id}/structure${anonToken ? `?token=${anonToken}` : ''}`
      const res = await api.post(url)
      onUpdated({ originalResumeData: res.data.data.originalResumeData })
    } catch (err) {
      setStructError(getErrorMessage(err, 'We couldn\'t read your file just now — try again in a minute.'))
    }
    setStructuring(false)
  }

  if (!data) {
    if (!isFile) return null
    return (
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6" data-testid="structure-preview">
        <h3 className="font-semibold text-gray-900">See what we read from your file</h3>
        <p className="text-sm text-gray-500 mt-0.5">
          If you buy a fix, we rebuild your resume from this. Check it first — a misread date or a missing job is
          easier to correct now than on the finished document.
        </p>
        <Alert className="mt-3">{structError}</Alert>
        <div className="mt-3">
          <Button variant="secondary" size="sm" onClick={handleStructure} loading={structuring}>Preview what we extracted</Button>
        </div>
      </div>
    )
  }

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

  // type: 'docx' | 'pdf'. The PDF is rendered on demand (a browser render), so it shows a busy state.
  async function handleDownloadDraft(type = 'docx') {
    setDlError('')
    if (type === 'pdf') setPdfLoading(true)
    try {
      const path = type === 'pdf' ? 'download-draft-pdf' : 'download-draft'
      const url = `/scan/${scan.id}/${path}${anonToken ? `?token=${anonToken}` : ''}`
      const res = await api.get(url, { responseType: 'blob' })
      const stem = String(data.name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
      downloadBlob(res.data, `${stem ? `${stem}-` : ''}resume-draft.${type === 'pdf' ? 'pdf' : 'docx'}`)
    } catch (err) {
      setDlError(getErrorMessage(err, 'Could not download your draft — try again.'))
    }
    if (type === 'pdf') setPdfLoading(false)
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 className="font-semibold text-gray-900">{isFile ? 'The resume we read from your file' : 'The resume we built from your text'}</h3>
          <p className="text-sm text-gray-500 mt-0.5">
            {isFile
              ? 'This is what a fix would rebuild your document from. Correct anything we misread — your score is re-checked from the corrected version.'
              : 'Review what we extracted before deciding anything — fix anything that\'s missing or wrong.'}
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          {!editing && (
            <Button variant="secondary" size="sm" onClick={startEditing}>Review & edit</Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => handleDownloadDraft('docx')}>
            Download draft (.docx)
          </Button>
          <Button variant="secondary" size="sm" onClick={() => handleDownloadDraft('pdf')} loading={pdfLoading}>
            Download draft (.pdf)
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
      {data.volunteer?.length > 0 && (
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Volunteer ({data.volunteer.length})</p>
          <ul className="list-disc list-inside space-y-0.5">
            {data.volunteer.map((v, i) => <li key={i}>{v.role || 'Volunteer'}{v.organization ? ` at ${v.organization}` : ''}</li>)}
          </ul>
        </div>
      )}
      {['languages', 'awards', 'publications'].some(k => data[k]?.length > 0) && (
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Also captured</p>
          <p>{[['languages', 'Languages'], ['awards', 'Awards'], ['publications', 'Publications']]
            .filter(([k]) => data[k]?.length > 0).map(([k, label]) => `${data[k].length} ${label.toLowerCase()}`).join(' · ')}</p>
        </div>
      )}
      {missingHints(data).length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
          <p className="text-xs font-medium text-amber-900 mb-1">Worth adding before you send this anywhere:</p>
          <ul className="text-xs text-amber-800 list-disc list-inside space-y-0.5">
            {missingHints(data).map(h => <li key={h}>{h}</li>)}
          </ul>
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
