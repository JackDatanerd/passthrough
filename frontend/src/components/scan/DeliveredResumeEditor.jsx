import { useState } from 'react'
import ResumeFieldsForm from './ResumeFieldsForm'
import api, { getErrorMessage } from '../../lib/api'
import Button from '../ui/Button'
import Alert from '../ui/Alert'
import { ATS_BADGE_THRESHOLD } from '../../lib/scoreThresholds'

// FEATURE GAP CLOSED (Scan/ATS pass): a delivered resume could not be changed — not a typo, not
// the number the "Strengthen these lines" panel asks for, not a job to drop for one application.
// PATCH /scan/:id/delivered-resume rebuilds both files from the person's own edit, scores them
// the way the delivery was scored, and keeps the verification link. Owner-only; the parent
// decides when to render it (delivered, signed in as the owner).
export default function DeliveredResumeEditor({ scan, onSaved }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)

  const data = scan.rewrittenResumeData || scan.originalResumeData
  if (!data) return null
  const plain = scan.fixTier === 'FIX_PLAIN'

  function start() {
    setDraft(JSON.parse(JSON.stringify(data)))
    setError(''); setResult(null); setEditing(true)
  }

  async function save() {
    setSaving(true); setError('')
    try {
      const res = await api.patch(`/scan/${scan.id}/delivered-resume`, { resumeData: draft })
      const d = res.data.data
      setResult({ score: d.fixAtsScore, verified: d.credentialVerified })
      setEditing(false)
      await onSaved(d)
    } catch (err) {
      setError(getErrorMessage(err, 'Could not save your changes — try again.'))
    }
    setSaving(false)
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6" data-testid="delivered-editor">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 className="font-semibold text-gray-900">Edit your delivered resume</h3>
          <p className="text-sm text-gray-500 mt-0.5">
            Fix a typo, add a number, or drop something for one application. Saving rebuilds both files
            {plain ? '' : ' and re-checks your score — your verification link stays the same, and anyone holding an earlier copy is told it is an earlier version'}.
          </p>
        </div>
        {!editing && <Button variant="secondary" size="sm" onClick={start}>Edit resume</Button>}
      </div>

      {result && !editing && (
        <p className={`text-sm mt-3 ${plain || result.verified ? 'text-green-800' : 'text-amber-800'}`} role="status">
          Saved — new ATS score {result.score}/100
          {!plain && (result.verified ? ' · still Passthrough Verified.' : ` · below ${ATS_BADGE_THRESHOLD}, so the files now carry the Scan Report wording instead of Verified.`)}
        </p>
      )}

      {editing && (
        <div className="mt-4 flex flex-col gap-5">
          <ResumeFieldsForm draft={draft} setDraft={setDraft} />
          <Alert>{error}</Alert>
          <div className="flex gap-3">
            <Button onClick={save} loading={saving}>Save &amp; rebuild files</Button>
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={saving}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  )
}
