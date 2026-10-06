import { useEffect, useState } from 'react'
import api, { getErrorMessage } from '../../lib/api'
import Button from '../ui/Button'
import Spinner from '../ui/Spinner'
import ResumeFieldsForm from '../scan/ResumeFieldsForm'
import Alert from '../ui/Alert'

// FEATURE GAP CLOSED (Profile & Dashboard round 5): a saved profile could be viewed only as
// counts and replaced only by saving a different scan, so a wrong job date or a stale skills
// list meant going back to a scan, correcting it there, and saving again. This loads the saved
// resume (GET /profile/data) into the same field form the scan-result editor uses and writes it
// back in place (PUT /profile). The server validates exactly as it does for a scan correction.
//
// Rendered only while the person is editing; `onSaved` lets Settings refresh its summary and
// `onClose` returns it to the read-only view.
export default function SavedProfileEditor({ onSaved, onClose }) {
  const [draft, setDraft] = useState(null)          // null = loading
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  useEffect(() => {
    let cancelled = false
    api.get('/profile/data')
      .then(res => { if (!cancelled) setDraft(JSON.parse(JSON.stringify(res.data.data.resumeData || {}))) })
      .catch(err => { if (!cancelled) setLoadError(getErrorMessage(err, "Couldn't load your saved profile.")) })
    return () => { cancelled = true }
  }, [])

  async function handleSave() {
    setSaving(true); setSaveError('')
    try {
      await api.put('/profile', { resumeData: draft })
      onSaved?.()
      onClose?.()
    } catch (err) {
      setSaveError(getErrorMessage(err, 'Could not save your changes — try again.'))
      setSaving(false)
    }
  }

  if (loadError) {
    return (
      <div role="alert" className="mt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <p className="text-sm text-red-600">{loadError}</p>
        <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
      </div>
    )
  }
  if (draft === null) return <div className="mt-4 flex justify-center"><Spinner /></div>

  return (
    <div className="mt-4 flex flex-col gap-5">
      <ResumeFieldsForm draft={draft} setDraft={setDraft} />
      <Alert>{saveError}</Alert>
      <div className="flex gap-3">
        <Button onClick={handleSave} loading={saving}>Save changes</Button>
        <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
      </div>
    </div>
  )
}
