import { useEffect, useState } from 'react'
import api, { getErrorMessage } from '../../lib/api'
import Button from '../ui/Button'
import Alert from '../ui/Alert'
import Checkbox from '../ui/Checkbox'
import { markOptions, normalizeMarks, marksEqual } from '../../lib/docMarks'

// Which Passthrough marks the owner's delivered files carry (look 4, PATCH /scan/:id/doc-marks). Everything starts ticked. Applying rebuilds the
// .docx and the PDF from the stored resume (no re-scoring, no AI call), so it takes a few seconds and leaves the verification link as it was.
// The page's own verdict is unaffected: unticking everything sends a resume with no Passthrough reference, not an unverified one.
export default function DocMarksPanel({ scan, verified, onChanged }) {
  const saved = normalizeMarks(scan?.docMarks)
  const [draft, setDraft] = useState(saved)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')
  // Follow the server after a save or a refetch.
  useEffect(() => { setDraft(normalizeMarks(scan?.docMarks)) }, [scan?.docMarks?.header, scan?.docMarks?.colophon, scan?.docMarks?.footer])  // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = !marksEqual(draft, saved)
  const none = !draft.header && !draft.colophon && !draft.footer

  async function apply() {
    if (saving || !dirty) return
    setSaving(true); setError(''); setDone('')
    try {
      await api.patch(`/scan/${scan.id}/doc-marks`, draft)
      setDone('Done. Your Word and PDF files were rebuilt with these badges. Download them again to get the new versions.')
      if (onChanged) await onChanged()
    } catch (err) {
      setError(getErrorMessage(err, 'Could not rebuild your files just now. Nothing was changed - please try again in a minute.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <fieldset className="mb-4 rounded-lg border border-green-200 bg-white p-4" disabled={saving} data-testid="doc-marks">
      <legend className="px-1 text-sm font-semibold text-gray-900">Show Passthrough on your resume</legend>
      <p className="mb-3 text-xs text-gray-500">Choose what your downloads carry. Your verification link stays live whatever you choose.</p>
      <div className="flex flex-col gap-3">
        {markOptions(verified).map(o => (
          <Checkbox key={o.key} label={o.label} description={o.description} alignTop
            checked={draft[o.key]} onChange={e => { setDraft(d => ({ ...d, [o.key]: e.target.checked })); setDone('') }} />
        ))}
      </div>
      {none && <p className="mt-3 text-xs text-amber-700" role="status">With all three off, your files carry no mention of Passthrough. Employers can no longer scan or look up your verification from the file.</p>}
      <Alert className="mt-3">{error}</Alert>
      {done && !dirty && <p className="mt-3 text-sm text-green-800" role="status">{done}</p>}
      <div className="mt-3">
        <Button type="button" variant="secondary" onClick={apply} loading={saving} disabled={!dirty && !saving}>Apply to my files</Button>
      </div>
    </fieldset>
  )
}
