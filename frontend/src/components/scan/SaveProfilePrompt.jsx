import { useState, useEffect } from 'react'
import api, { getErrorMessage } from '../../lib/api'
import Button from '../ui/Button'
import Input from '../ui/Input'
import RadioGroup from '../ui/RadioGroup'
import ConfirmDialog from '../ui/ConfirmDialog'
import { formatDate } from '../../lib/utils'

// Phase 4 — explicit opt-in only. Profile data (name, email, phone, work
// history) is PII; nothing in this app persists it beyond a single scan's
// own record without the user actively choosing to. This mirrors the
// consent-forward pattern used throughout — e.g. AI-added skills in
// DiffView are flagged for the user's own judgment rather than silently
// trusted, and here saving anything long-lived is a deliberate action,
// never a side effect of viewing a result.
//
// Rendered only for logged-in users with structured resume data on the
// scan (ScanResult.jsx gates on both). Saving POSTs just the scanId — see
// profile.controller.js for why the server derives the data server-side
// rather than trusting a client-supplied payload here.

export default function SaveProfilePrompt({ scanId, deliveredAvailable = false }) {
  const [status, setStatus] = useState('idle') // idle | saving | saved | error
  const [error,  setError ] = useState('')
  // What is already saved (if anything). Saving overwrites it — one profile per
  // account — so the prompt says so, and says when THIS scan is already it,
  // instead of offering an unexplained button every visit.
  const [existing, setExisting] = useState(null)   // { savedAt, editedAt, sourceScanId } | null
  // Saving REPLACES the saved profile — including corrections typed into the Settings editor.
  // Replacing those takes an explicit yes (the server refuses with 409 PROFILE_EDITED otherwise).
  const [confirmOpen, setConfirmOpen] = useState(false)
  // "Keep as another profile": saved under a name next to the main one instead of replacing it.
  const [extraOpen, setExtraOpen] = useState(false)
  const [extraLabel, setExtraLabel] = useState('')
  const [extraCount, setExtraCount] = useState(0)
  const [extraMax, setExtraMax] = useState(4)
  // Which version to keep: the resume as uploaded / typed, or — once a fix was delivered — the improved one.
  const [version, setVersion] = useState('original')   // 'original' | 'delivered'
  const sourceBody = version === 'delivered' && deliveredAvailable ? { source: 'delivered' } : {}

  useEffect(() => {
    let cancelled = false
    api.get('/profile')
      .then(res => {
        const d = res.data.data
        if (!cancelled) { setExtraCount((d.extraProfiles || []).length); if (d.maxExtraProfiles) setExtraMax(d.maxExtraProfiles) }
        if (!cancelled && d.hasSavedProfile) setExisting({ savedAt: d.savedAt, editedAt: d.editedAt || null, sourceScanId: d.sourceScanId })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [scanId])

  async function handleSave(replaceEdited = false) {
    setStatus('saving')
    setError('')
    try {
      await api.post('/profile/save', { scanId, ...sourceBody, ...(replaceEdited ? { replaceEdited: true } : {}) })
      setConfirmOpen(false)
      setExisting({ savedAt: new Date().toISOString(), editedAt: null, sourceScanId: scanId })
      setStatus('saved')
    } catch (err) {
      if (err.response?.status === 409 && err.response?.data?.code === 'PROFILE_EDITED') {
        // Corrected by hand since this page loaded (another tab): ask, don't overwrite.
        setExisting(prev => ({ ...(prev || {}), editedAt: prev?.editedAt || new Date().toISOString() }))
        setStatus('idle')
        setConfirmOpen(true)
        return
      }
      setConfirmOpen(false)
      setError(getErrorMessage(err, 'Could not save profile.'))
      setStatus('error')
    }
  }

  async function handleSaveExtra() {
    setStatus('saving'); setError('')
    try {
      await api.post('/profile/save', { scanId, asExtra: true, label: extraLabel, ...sourceBody })
      setExtraOpen(false); setStatus('savedExtra')
    } catch (err) {
      setError(getErrorMessage(err, 'Could not save profile.')); setStatus('error')
    }
  }

  // A profile with hand corrections is replaced only after the person has agreed.
  const onSaveClick = () => (existing?.editedAt ? setConfirmOpen(true) : handleSave(false))

  const alreadyThis = !!existing && existing.sourceScanId === scanId

  if (status === 'savedExtra') {
    return (
      <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm text-green-800">
        Saved as another profile — choose it from the scan form or manage it in Settings.
      </div>
    )
  }

  if (status === 'saved') {
    return (
      <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm text-green-800">
        Profile saved — next time, translate it against a new job in one step from your dashboard.
      </div>
    )
  }

  return (
    <div className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div>
        <p className="text-sm font-medium text-gray-800">Save this profile for next time</p>
        <p className="text-xs text-gray-500 mt-0.5">
          {existing?.editedAt
            ? `Your saved profile has corrections you made by hand (${formatDate(existing.editedAt)}). Saving this scan replaces them.`
            : alreadyThis
            ? `This scan is your saved profile (saved ${formatDate(existing.savedAt)}). Save again to pick up any edits you've made since.`
            : existing
              ? `Reuse your background against a new job description in one step. This replaces the profile you saved on ${formatDate(existing.savedAt)}.`
              : 'Reuse your background against a new job description in one step — no re-uploading.'}
        </p>
        {deliveredAvailable && (
          <RadioGroup legend="Which version to save" srOnlyLegend size="sm" name={`profile-version-${scanId}`} value={version} onChange={setVersion}
            className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-700"
            options={[{ value: 'original', label: 'Your resume as it was' }, { value: 'delivered', label: 'The fixed version' }]} />
        )}
        {status === 'error' && <p role="alert" className="text-xs text-red-600 mt-1">{error}</p>}
      </div>
      <div className="flex flex-wrap gap-2 shrink-0 items-center">
        <Button onClick={onSaveClick} loading={status === 'saving'} variant="secondary" size="sm">
          {alreadyThis ? 'Save again' : existing ? 'Replace saved profile' : 'Save profile'}
        </Button>
        {existing && !alreadyThis && extraCount < extraMax && !extraOpen && (
          <Button onClick={() => setExtraOpen(true)} variant="secondary" size="sm">Keep as another profile</Button>
        )}
      </div>
      {extraOpen && (
        <form className="w-full flex flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); handleSaveExtra() }}>
          <Input size="sm" value={extraLabel} onChange={e => setExtraLabel(e.target.value)} maxLength={40}
            placeholder="Name this profile (e.g. Product roles)" aria-label="Profile name"
            wrapperClassName="flex-1 min-w-[12rem]" />
          <Button type="submit" size="sm" loading={status === 'saving'}>Save</Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => setExtraOpen(false)}>Cancel</Button>
        </form>
      )}
      <ConfirmDialog
        open={confirmOpen}
        title="Replace your edited profile?"
        message={`Your saved profile has corrections you made by hand${existing?.editedAt ? ` (${formatDate(existing.editedAt)})` : ''}. Saving this scan's profile replaces it, and those corrections are lost.`}
        confirmLabel="Replace it"
        cancelLabel="Keep my edits"
        loading={status === 'saving'}
        onConfirm={() => handleSave(true)}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  )
}
