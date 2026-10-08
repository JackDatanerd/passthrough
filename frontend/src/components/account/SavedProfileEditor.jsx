import { useEffect, useState } from 'react'
import api, { getErrorMessage } from '../../lib/api'
import Button from '../ui/Button'
import Spinner from '../ui/Spinner'
import ResumeFieldsForm from '../scan/ResumeFieldsForm'
import Alert from '../ui/Alert'

// Lets the person correct their saved profile in place: loads the saved resume (GET /profile/data)
// into the same field form the scan-result editor uses and writes it back (PUT /profile). The server
// validates exactly as it does for a scan correction.
//
// The profile can change under an open editor — another tab saving a different scan, or editing it.
// GET /profile/data hands back a `version`, PUT sends it back, and the server refuses (409
// PROFILE_CHANGED) a draft made from an older one rather than writing old content over a newer
// profile. The person is told, and can reload the current profile (their typed changes are dropped —
// the draft no longer matches what is stored, so there is nothing to merge it into).
//
// Rendered only while the person is editing; `onSaved` lets Settings refresh its summary and
// `onClose` returns it to the read-only view.
export default function SavedProfileEditor({ onSaved, onClose }) {
  const [draft, setDraft] = useState(null)          // null = loading
  const [version, setVersion] = useState(null)      // what the draft was made from
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [conflict, setConflict] = useState(false)   // the stored profile moved on since this opened
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    api.get('/profile/data')
      .then(res => {
        if (cancelled) return
        setDraft(JSON.parse(JSON.stringify(res.data.data.resumeData || {})))
        setVersion(typeof res.data.data.version === 'string' ? res.data.data.version : null)
      })
      .catch(err => { if (!cancelled) setLoadError(getErrorMessage(err, "Couldn't load your saved profile.")) })
    return () => { cancelled = true }
  }, [reloadTick])

  function reloadLatest() {
    setDraft(null); setLoadError(''); setSaveError(''); setConflict(false)
    setReloadTick(n => n + 1)
  }

  async function handleSave() {
    setSaving(true); setSaveError('')
    try {
      await api.put('/profile', version ? { resumeData: draft, version } : { resumeData: draft })
      onSaved?.()
      onClose?.()
    } catch (err) {
      if (err.response?.status === 409 && err.response?.data?.code === 'PROFILE_CHANGED') setConflict(true)
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
      <div className="flex flex-wrap gap-3">
        {conflict
          ? <Button onClick={reloadLatest}>Reload the current profile</Button>
          : <Button onClick={handleSave} loading={saving}>Save changes</Button>}
        <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
      </div>
    </div>
  )
}
