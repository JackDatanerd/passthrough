import { useEffect, useRef, useState } from 'react'
import api, { getErrorMessage } from '../../lib/api'
import Button from '../ui/Button'
import Spinner from '../ui/Spinner'
import ResumeFieldsForm from '../scan/ResumeFieldsForm'
import Alert from '../ui/Alert'
import ConfirmDialog from '../ui/ConfirmDialog'
import { useUnsavedChangesWarning } from '../../hooks/useUnsavedChangesWarning'

// Lets the person correct their saved profile in place: loads the saved resume (GET /profile/data)
// into the same field form the scan-result editor uses and writes it back (PUT /profile). The server
// validates exactly as it does for a scan correction.
//
// The profile can change under an open editor — another tab saving a different scan, or editing it.
// GET /profile/data hands back a `version`, PUT sends it back, and the server refuses (409
// PROFILE_CHANGED) a draft made from an older one rather than writing old content over a newer
// profile. The person is told and keeps their typed draft on screen: they can load the current profile
// (dropping the draft) or deliberately save their version over it — never one silently.
//
// Leaving with unsaved changes (closing the tab, Cancel, navigating away) asks first.
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
  const [confirmCancel, setConfirmCancel] = useState(false)
  // The draft as loaded, to tell whether anything was typed.
  const baseline = useRef(null)
  const dirty = draft !== null && baseline.current !== null && JSON.stringify(draft) !== baseline.current

  useUnsavedChangesWarning(dirty)

  useEffect(() => {
    let cancelled = false
    api.get('/profile/data')
      .then(res => {
        if (cancelled) return
        const loaded = JSON.parse(JSON.stringify(res.data.data.resumeData || {}))
        baseline.current = JSON.stringify(loaded)
        setDraft(loaded)
        setVersion(typeof res.data.data.version === 'string' ? res.data.data.version : null)
      })
      .catch(err => { if (!cancelled) setLoadError(getErrorMessage(err, "Couldn't load your saved profile.")) })
    return () => { cancelled = true }
  }, [reloadTick])

  function reloadLatest() {
    setDraft(null); setLoadError(''); setSaveError(''); setConflict(false)
    setReloadTick(n => n + 1)
  }

  async function handleSave(overrideVersion) {
    setSaving(true); setSaveError('')
    const sendVersion = typeof overrideVersion === 'string' ? overrideVersion : version
    try {
      await api.put('/profile', sendVersion ? { resumeData: draft, version: sendVersion } : { resumeData: draft })
      baseline.current = JSON.stringify(draft)
      onSaved?.()
      onClose?.()
    } catch (err) {
      if (err.response?.status === 409 && err.response?.data?.code === 'PROFILE_CHANGED') setConflict(true)
      setSaveError(getErrorMessage(err, 'Could not save your changes — try again.'))
      setSaving(false)
    }
  }

  // The person chose to keep their draft over the profile that moved on: take the current version and
  // save against it. The newer content is replaced — that is exactly what was asked for.
  async function saveOverCurrent() {
    setSaving(true); setSaveError('')
    try {
      const res = await api.get('/profile/data')
      const latest = res.data?.data?.version
      if (typeof latest !== 'string') throw new Error('no version')
      setVersion(latest); setConflict(false)
      await handleSave(latest)
    } catch (err) {
      if (err.response?.status === 404) setSaveError('Your saved profile was removed in the meantime, so there is nothing to save over. Save one from a completed scan first.')
      else setSaveError(getErrorMessage(err, 'Could not save your changes — try again.'))
      setSaving(false)
    }
  }

  function requestClose() {
    if (dirty) setConfirmCancel(true)
    else onClose?.()
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
        {conflict ? (
          <>
            <Button onClick={reloadLatest} disabled={saving}>Load the current profile (drops my edits)</Button>
            <Button variant="secondary" onClick={saveOverCurrent} loading={saving}>Save my version over it</Button>
          </>
        ) : (
          <Button onClick={() => handleSave()} loading={saving}>Save changes</Button>
        )}
        <Button variant="ghost" onClick={requestClose} disabled={saving}>Cancel</Button>
      </div>
      <ConfirmDialog
        open={confirmCancel}
        title="Discard your changes?"
        message="You have edits to your saved profile that are not saved."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        onConfirm={() => { setConfirmCancel(false); onClose?.() }}
        onCancel={() => setConfirmCancel(false)}
      />
    </div>
  )
}
