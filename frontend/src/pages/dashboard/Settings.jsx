import { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import api, { getErrorMessage } from '../../lib/api'
import { useAuth } from '../../hooks/useAuth'
import DashboardLayout from '../../components/layout/DashboardLayout'
import Button from '../../components/ui/Button'
import Form from '../../components/ui/Form'
import Input from '../../components/ui/Input'
import PasswordInput from '../../components/ui/PasswordInput'
import { getToken, setToken, storageSet } from '../../lib/storage'
import Modal from '../../components/ui/Modal'
import ConfirmDialog from '../../components/ui/ConfirmDialog'
import { formatDate, formatDateTime } from '../../lib/utils'
import { exportFileName, exportPartsFrom, exportCursorFrom } from '../../lib/dataExport'
import { purgeScans, partialDeleteNote } from '../../lib/purgeScans'
import { passwordProblem } from '../../lib/passwordRules'
import { roleLabel } from '../../lib/roleCategories'
import SessionsCard from '../../components/account/SessionsCard'
import SavedProfileEditor from '../../components/account/SavedProfileEditor'
import { USER_KEY } from '../../lib/session'
import { isAlreadyVerified } from '../../lib/resendVerification'
import Checkbox from '../../components/ui/Checkbox'

export default function Settings() {
  const navigate      = useNavigate()
  const { user, setUser, logout, refreshUser } = useAuth()

  // AUDIT FIX (Section 6): Account previously showed name/email as static
  // text with no way to ever change either — no endpoint existed for it.
  const [name,        setName       ] = useState('')
  const [nameLoading,  setNameLoading ] = useState(false)
  const [nameError,    setNameError   ] = useState('')
  const [nameSuccess,  setNameSuccess ] = useState(false)
  // A background refreshUser() (mount, or after another save) must not
  // overwrite text the user is in the middle of typing.
  const [nameDirty,    setNameDirty   ] = useState(false)

  const [newEmail,      setNewEmail     ] = useState('')
  const [emailPassword, setEmailPassword] = useState('')
  const [emailLoading,  setEmailLoading ] = useState(false)
  const [emailError,    setEmailError   ] = useState('')
  const [emailSuccess,  setEmailSuccess ] = useState(false)

  // AUDIT FIX: the "Email verified: No" status here was inert text with no
  // way to act on it — the actual resend-verification button only existed
  // on dashboard/Index.jsx. Same request/refresh pattern as that one.
  const [resending, setResending] = useState(false)
  const [resentOk,  setResentOk ] = useState(false)
  const [resendError, setResendError] = useState('')

  async function handleResendVerification() {
    setResending(true); setResendError('')
    try {
      await api.post('/auth/resend-verification')
      setResentOk(true)
      refreshUser()
    } catch (err) {
      setResendError(getErrorMessage(err, 'Could not resend verification email.'))
      // "Already verified." = verified on another device meanwhile: re-sync so this page says so.
      if (isAlreadyVerified(err)) refreshUser()
    } finally {
      setResending(false)
    }
  }

  useEffect(() => {
    if (user?.name && !nameDirty) setName(user.name)
  }, [user?.name, nameDirty])

  // Swaps a field of the cached user in place (state AND the localStorage copy AuthProvider
  // reads on the next load) from a response we already hold, so the page is right at once and
  // does not depend on a second request succeeding.
  function applyUserPatch(patch) {
    // No token = signed out while the request was in flight (AUDIT FIX, Auth round 4, B2): writing the
    // user back would strand it in storage with nothing to authenticate it.
    if (!getToken()) return
    const next = { ...(user || {}), ...patch }
    storageSet(USER_KEY, JSON.stringify(next))
    setUser(next)
  }

  async function handleUpdateName() {
    if (!name.trim()) return setNameError('Name is required.')
    setNameLoading(true); setNameError(''); setNameSuccess(false)
    try {
      const res = await api.patch('/auth/name', { name: name.trim() })
      // The server answers with the saved user. Previously the "dirty" flag was cleared first,
      // which let the sync effect above put the OLD cached name back into the field until a
      // refresh finished — and if that refresh failed, the old name stayed next to "Name
      // updated." Field, cache and flag now change together, from the response.
      const savedName = res.data?.data?.user?.name ?? name.trim()
      setName(savedName)
      applyUserPatch({ name: savedName })
      setNameDirty(false)
      setNameSuccess(true)
      refreshUser()
    } catch (err) {
      setNameError(getErrorMessage(err, 'Failed to update name.'))
    } finally {
      setNameLoading(false)
    }
  }

  // BUG FIX (Section 6, second fixing-time pass): updateEmail no longer
  // flips the live email immediately — it stages a pending change that only
  // takes effect once the NEW address confirms (see auth.controller.js's own
  // comment for the full reasoning). The success message and the account
  // section below reflect that: the current email keeps working, and a
  // "confirmation pending" notice appears until it's confirmed or canceled.
  async function handleUpdateEmail() {
    if (!newEmail || !emailPassword) return setEmailError('New email and password required.')
    setEmailLoading(true); setEmailError(''); setEmailSuccess(false)
    try {
      await api.patch('/auth/email', { newEmail, password: emailPassword })
      await refreshUser()
      setEmailSuccess(true)
      setNewEmail(''); setEmailPassword('')
    } catch (err) {
      setEmailError(getErrorMessage(err, 'Failed to update email.'))
    } finally {
      setEmailLoading(false)
    }
  }

  // Cancelling asks for the password again, like the change itself. It used to
  // be a window.prompt(), which shows what you type in clear text, can't be
  // masked, and is silently blocked in some in-app browsers.
  const [cancelOpen,       setCancelOpen      ] = useState(false)
  const [cancelPassword,   setCancelPassword  ] = useState('')
  const [cancelError,      setCancelError     ] = useState('')
  const [cancelingPending, setCancelingPending] = useState(false)

  function closeCancel() {
    if (cancelingPending) return
    setCancelOpen(false); setCancelPassword(''); setCancelError('')
  }

  async function handleCancelPendingEmail() {
    if (!cancelPassword) return setCancelError('Password required.')
    setCancelingPending(true); setCancelError('')
    try {
      await api.patch('/auth/email', { newEmail: user.email, password: cancelPassword, cancelPending: true })
      await refreshUser()
      setCancelOpen(false); setCancelPassword('')
    } catch (err) {
      setCancelError(getErrorMessage(err, 'Failed to cancel.'))
    } finally {
      setCancelingPending(false)
    }
  }

  // Bumped whenever the account's sessions change under this tab (sign-out-everything, a password
  // change — which revokes every session and starts a new one for this browser) so the devices list
  // below re-reads instead of showing sessions that no longer exist.
  const [sessionsReload, setSessionsReload] = useState(0)

  // Change password
  const [current,  setCurrent ] = useState('')
  const [newPass,  setNewPass ] = useState('')
  const [confirm,  setConfirm ] = useState('')
  const [pwLoading, setPwLoading] = useState(false)
  const [pwError,   setPwError  ] = useState('')
  const [pwSuccess, setPwSuccess] = useState(false)

  // FEATURE (Auth section audit): previously the only way to kill sessions
  // on other devices was as a side effect of changing the password — no
  // option for "just sign out that lost/stolen phone, nothing else wrong".
  const [signOutLoading, setSignOutLoading] = useState(false)
  const [signOutError,   setSignOutError  ] = useState('')
  const [signOutSuccess, setSignOutSuccess] = useState(false)

  // PHASE 4 — saved profile management. Closes the consent loop: saving a
  // profile (ScanResult.jsx / SaveProfilePrompt) is an explicit opt-in, so
  // removing it needs to be just as easy, without going all the way to
  // deleting the whole account.
  const [profileLoading, setProfileLoading] = useState(true)
  // A failed load used to be swallowed and fell through to "No saved profile
  // yet" — for someone who HAS one, that hid the only control for removing
  // stored personal data, and said something untrue about what we hold.
  const [profileError, setProfileError] = useState('')
  const [hasSavedProfile, setHasSavedProfile] = useState(false)
  const [savedAt,         setSavedAt        ] = useState(null)
  // FEATURE GAP CLOSED (Section 6, fixing-time pass): a saved profile used
  // to be a bare save-date with no way to see what's actually in it or
  // where it came from — the only "fix" for a bad save was delete-and-
  // rescan-from-scratch. getProfile now also returns sourceScanId (so this
  // page can link back to the original scan) and a small summary.
  const [sourceScanId,   setSourceScanId   ] = useState(null)
  const [editedAt,        setEditedAt       ] = useState(null)
  const [editingProfile,  setEditingProfile ] = useState(false)
  // null until the profile read succeeds: showing a toggle for a preference we could not read
  // would show (and then save over) a guess.
  const [notifyScanResults, setNotifyScanResults] = useState(null)
  const [prefSaving, setPrefSaving] = useState(false)
  const [prefError,  setPrefError ] = useState('')
  const [profileSummary, setProfileSummary ] = useState(null)
  const [removing,        setRemoving       ] = useState(false)
  const [removeError,     setRemoveError    ] = useState('')
  // FEATURE GAP CLOSED (fresh audit pass, Section 6): "Remove saved profile"
  // used to fire on a single click with no confirmation at all — unlike scan
  // deletion (Index.jsx's ConfirmDialog) and account deletion (the password-
  // gated modal below), both of which confirm before doing something the
  // person can't undo. Removing a saved profile is just as permanent, so it
  // gets the same ConfirmDialog treatment as scan deletion.
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false)

  // Additional named profiles (up to maxExtras), kept next to the main saved profile.
  const [extraProfiles, setExtraProfiles] = useState([])
  const [maxExtras, setMaxExtras] = useState(4)
  const [editingExtraId, setEditingExtraId] = useState(null)
  const [renameId, setRenameId] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  const [extraBusy, setExtraBusy] = useState(false)
  const [extraError, setExtraError] = useState('')
  const [removeExtraTarget, setRemoveExtraTarget] = useState(null)
  const [downloadingFile, setDownloadingFile] = useState('')   // e.g. 'primary:pdf' while a render runs

  // Save the profile as a resume document. profileId absent = the main profile.
  async function downloadProfileFile(kind, profileId, name) {
    const key = `${profileId || 'primary'}:${kind}`
    setDownloadingFile(key); setExtraError('')
    try {
      const res = await api.get(`/profile/download-${kind}`, { params: profileId ? { profileId } : {}, responseType: 'blob' })
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      const stem = String(name || 'resume').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'resume'
      a.href = url; a.download = `${stem}-resume.${kind}`
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) {
      setExtraError(getErrorMessage(err, 'Could not download the profile.'))
    } finally {
      setDownloadingFile('')
    }
  }

  async function handleRenameExtra(id) {
    setExtraBusy(true); setExtraError('')
    try {
      await api.put(`/profile/extras/${id}`, { label: renameValue })
      setRenameId(null)
      await loadProfile({ quiet: true })
    } catch (err) {
      setExtraError(getErrorMessage(err, 'Could not rename the profile.'))
    } finally { setExtraBusy(false) }
  }

  async function handleRemoveExtra() {
    const target = removeExtraTarget
    if (!target) return
    setExtraBusy(true); setExtraError('')
    try {
      await api.delete(`/profile/extras/${target.id}`)
      if (editingExtraId === target.id) setEditingExtraId(null)
      await loadProfile({ quiet: true })
    } catch (err) {
      setExtraError(getErrorMessage(err, 'Failed to remove the profile.'))
    } finally { setExtraBusy(false); setRemoveExtraTarget(null) }
  }

  // `quiet`: a refresh while the card is already showing something (after a purge, after an edit was
  // saved). The card must not drop to "Loading…" — that unmounts an open editor and throws away what is
  // typed into it — and a failed quiet refresh keeps what is on screen rather than replacing it.
  function loadProfile({ quiet = false } = {}) {
    if (!quiet) { setProfileLoading(true); setProfileError('') }
    return api.get('/profile')
      .then(res => {
        setHasSavedProfile(!!res.data.data.hasSavedProfile)
        setExtraProfiles(res.data.data.extraProfiles || [])
        if (res.data.data.maxExtraProfiles) setMaxExtras(res.data.data.maxExtraProfiles)
        setSavedAt(res.data.data.savedAt)
        setSourceScanId(res.data.data.sourceScanId)
        setEditedAt(res.data.data.editedAt || null)
        setProfileSummary(res.data.data.summary)
        const pref = res.data.data.preferences?.notifyScanResults
        setNotifyScanResults(typeof pref === 'boolean' ? pref : null)
      })
      .catch(err => { if (!quiet) setProfileError(getErrorMessage(err, "Couldn't check your saved profile.")) })
      .finally(() => { if (!quiet) setProfileLoading(false) })
  }

  useEffect(() => {
    loadProfile()

    // Same stale-cache fix as Dashboard/Index.jsx — see that file's comment.
    refreshUser()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleRemoveProfile() {
    setRemoving(true); setRemoveError('')
    try {
      await api.delete('/profile')
      setHasSavedProfile(false)
      setSavedAt(null)
      setSourceScanId(null)
      setEditedAt(null)
      setEditingProfile(false)
      setProfileSummary(null)
      setRemoveConfirmOpen(false)
    } catch (err) {
      setRemoveError(getErrorMessage(err, 'Failed to remove saved profile.'))
      setRemoveConfirmOpen(false)
    } finally {
      setRemoving(false)
    }
  }

  async function handleToggleNotify(e) {
    const next = e.target.checked
    setNotifyScanResults(next); setPrefSaving(true); setPrefError('')
    try {
      await api.patch('/profile/preferences', { notifyScanResults: next })
    } catch (err) {
      setNotifyScanResults(!next)
      setPrefError(getErrorMessage(err, "Couldn't save that setting."))
    } finally {
      setPrefSaving(false)
    }
  }

  // Delete the whole scan history (not the account, not payments). The server removes it in
  // small batches and says how many are left, so this loops with a running count instead of
  // one request that has to finish a large history inside a single call.
  const [purgeOpen,   setPurgeOpen  ] = useState(false)
  const [purging,     setPurging    ] = useState(false)
  const [purgeCount,  setPurgeCount ] = useState(0)
  const [purgeError,  setPurgeError ] = useState('')
  const [purgeResult, setPurgeResult] = useState(null)   // { deleted, remaining }

  async function handlePurgeHistory() {
    setPurging(true); setPurgeError(''); setPurgeResult(null); setPurgeCount(0)
    try {
      setPurgeResult(await purgeScans(api, { onProgress: setPurgeCount }))
    } catch (err) {
      setPurgeError(getErrorMessage(err, 'Could not delete your scan history.') + partialDeleteNote(err.purgeDeleted))
    } finally {
      setPurging(false); setPurgeOpen(false)
      loadProfile({ quiet: true })   // the saved profile's "view source scan" link may have just been cleared
    }
  }

  // Download everything the account holds as JSON. A large account is split into
  // several files (the server caps each part); part 1 is downloaded first and the
  // rest are offered as buttons, so nobody is handed an incomplete export
  // without being told.
  const [exporting,   setExporting  ] = useState(false)
  const [exportError, setExportError] = useState('')
  const [exportParts, setExportParts] = useState(0)          // 0 until a first part has been downloaded
  const [exportedParts, setExportedParts] = useState([])
  const [exportingPart, setExportingPart] = useState(0)
  // Where each later part starts (part number -> server cursor), learned from the part before it.
  // With cursors, a scan deleted between two downloads cannot fall through the gap between
  // files, so a part is offered only once its predecessor has been downloaded. An empty map
  // after part 1 means the server sent none (a hidden header): parts then page by offset, in any order.
  const [exportCursors, setExportCursors] = useState({})
  const [cursorMode, setCursorMode] = useState(false)

  async function downloadExportPart(part) {
    setExportError('')
    part === 1 ? setExporting(true) : setExportingPart(part)
    try {
      const params = { part }
      if (exportCursors[part]) params.cursor = exportCursors[part]
      const res = await api.get('/profile/export', { params, responseType: 'blob' })
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url; a.download = exportFileName(part)
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      const next = exportCursorFrom(res)
      if (part === 1) {
        setExportParts(await exportPartsFrom(res)); setExportedParts([1])
        // A fresh part 1 starts the chain over: cursors from an earlier run may be stale.
        setExportCursors(next ? { 2: next } : {}); setCursorMode(!!next)
      } else {
        setExportedParts(prev => prev.includes(part) ? prev : [...prev, part])
        if (next) setExportCursors(prev => ({ ...prev, [part + 1]: next }))
      }
    } catch (err) {
      setExportError(getErrorMessage(err, 'Could not export your data.'))
    } finally {
      // BUG FIX (fresh audit pass, Section 6): this used to clear BOTH
      // `exporting` and `exportingPart` unconditionally, regardless of which
      // part's request the call was actually for. With nothing else blocking
      // a click on a different part's button while this one was still in
      // flight, whichever request happened to finish first cleared the
      // OTHER part's spinner and re-enabled its button mid-request — letting
      // it be clicked again while the original download was still pending.
      // Only clear the flag this call itself set.
      if (part === 1) setExporting(false)
      else setExportingPart(0)
    }
  }
  const handleExport = () => downloadExportPart(1)

  // Delete account
  const [deleteOpen,    setDeleteOpen   ] = useState(false)
  const [deletePass,    setDeletePass   ] = useState('')
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [deleteError,   setDeleteError  ] = useState('')

  async function handleChangePassword() {
    if (!current || !newPass) return setPwError('All fields required.')
    // FEATURE (Auth section, feature-gap-closing pass): was `.length < 8`
    // only — see passwordRules.js.
    const pwProblem = passwordProblem(newPass, user?.email)
    if (pwProblem) return setPwError(pwProblem)
    if (newPass === current) return setPwError('Your new password must be different from your current one.')
    if (newPass !== confirm) return setPwError('Passwords do not match.')
    setPwLoading(true); setPwError(''); setPwSuccess(false)
    try {
      const res = await api.patch('/auth/password', { currentPassword: current, newPassword: newPass })
      // BUG FIX: changePassword invalidates every existing token (including
      // this tab's) and now returns a freshly-signed one — store it so this
      // session survives, matching what the success message already says
      // ("Other sessions signed out"). Without this, the very next request
      // anywhere in the app 401'd and silently bounced to /login, right
      // after this screen told the user everything was fine.
      const token = res.data?.data?.token
      if (token) setToken(token)
      // BUG FIX (fresh audit pass, Section 6): a successful password change
      // never refreshed the cached user — unlike every other mutating
      // action on this page (handleUpdateEmail, handleCancelPendingEmail).
      // The backend clears any in-flight pending_email as part of this same
      // update (auth.controller.js's changePassword — a password change
      // should invalidate a pending email change too), but without this the
      // "Confirmation pending" banner above kept showing a change that no
      // longer existed server-side. Clicking its Cancel button then hit
      // updateEmail's `newEmail === user.email` branch with pendingEmail
      // already false, surfacing an unrelated "That is already your email
      // address." error instead of a clean no-op.
      await refreshUser()
      setSessionsReload(n => n + 1)
      setPwSuccess(true)
      setCurrent(''); setNewPass(''); setConfirm('')
    } catch (err) {
      setPwError(getErrorMessage(err, 'Failed to update password.'))
    } finally {
      setPwLoading(false)
    }
  }

  async function handleSignOutOtherSessions() {
    setSignOutLoading(true); setSignOutError(''); setSignOutSuccess(false)
    try {
      const res = await api.post('/auth/sessions/revoke-others')
      // Same reasoning as handleChangePassword's own token swap above: this
      // bumps token_version too, so the current tab needs the fresh token
      // the endpoint hands back or its very next request 401s and bounces
      // to /login right after this screen said everything was fine.
      const token = res.data?.data?.token
      if (token) setToken(token)
      setSignOutSuccess(true)
      setSessionsReload(n => n + 1)
    } catch (err) {
      setSignOutError(getErrorMessage(err, 'Failed to sign out other sessions.'))
    } finally {
      setSignOutLoading(false)
    }
  }

  // Closing the dialog must also clear what was typed into it — the password
  // and any error used to linger in state and reappear on the next open.
  function closeDelete() {
    if (deleteLoading) return
    setDeleteOpen(false); setDeletePass(''); setDeleteError('')
  }

  async function handleDeleteAccount() {
    if (!deletePass) return setDeleteError('Password required.')
    setDeleteLoading(true); setDeleteError('')
    try {
      await api.delete('/auth/account', { data: { password: deletePass } })
      logout()
      navigate('/')
    } catch (err) {
      setDeleteError(getErrorMessage(err, 'Failed to delete account.'))
      setDeleteLoading(false)
    }
  }

  return (
    <DashboardLayout>
      <div className="flex flex-col gap-8 max-w-lg">
        <h1 className="text-xl font-bold text-gray-900">Settings</h1>

        {/* Account info */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="font-semibold text-gray-900 mb-4">Account</h2>
          <div className="flex flex-col gap-3">
            <div>
              <p className="text-sm text-gray-600 mb-2">
                <span className="font-medium">Email verified:</span>{' '}
                {user?.emailVerified
                  ? <span className="text-green-700">Yes</span>
                  : <span className="text-amber-600">No — check your inbox</span>
                }
              </p>
              {!user?.emailVerified && (
                <div className="flex items-center gap-2">
                  {resentOk ? (
                    <span className="text-xs text-green-700 bg-green-100 px-3 py-1.5 rounded-md">Sent!</span>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={handleResendVerification} loading={resending}>
                      Resend verification email
                    </Button>
                  )}
                  {resendError && <p role="alert" className="text-sm text-red-600">{resendError}</p>}
                </div>
              )}
            </div>

            <Form onSubmit={handleUpdateName} className="flex flex-col sm:flex-row gap-2 sm:items-end">
              <Input label="Name" value={name} autoComplete="name" onChange={e => { setName(e.target.value); setNameDirty(true); setNameSuccess(false) }} />
              <Button type="submit" loading={nameLoading} variant="secondary" size="sm">
                Save
              </Button>
            </Form>
            {nameError   && <p role="alert" className="text-sm text-red-600">{nameError}</p>}
            {nameSuccess && <p role="status" className="text-sm text-green-700">Name updated.</p>}

            <Form onSubmit={handleUpdateEmail} className="flex flex-col gap-2 pt-2 border-t border-gray-100">
              <p className="text-sm text-gray-600"><span className="font-medium">Current email:</span> {user?.email}</p>
              {/* FEATURE GAP CLOSED / BUG FIX (Section 6, second fixing-time
                  pass): a change used to take effect the instant a password
                  was supplied, with no confirmation and no way back. This
                  banner is the only place that reality is now visible — the
                  address above stays live and correct until the one below is
                  confirmed. */}
              {user?.pendingEmail && (
                <div className="text-sm bg-amber-50 border border-amber-200 text-amber-800 rounded-md px-3 py-2 flex items-center justify-between gap-2 flex-wrap">
                  <span>Confirmation pending for <strong>{user.pendingEmail}</strong> — check that inbox{user.pendingEmailExpiry && <> (the link works until {formatDateTime(user.pendingEmailExpiry)})</>}.</span>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setCancelOpen(true)}>
                    Cancel
                  </Button>
                </div>
              )}
              <Input label="New email" type="email" value={newEmail}
                onChange={e => { setNewEmail(e.target.value); setEmailSuccess(false) }} />
              <PasswordInput label="Password" value={emailPassword}
                onChange={e => { setEmailPassword(e.target.value); setEmailSuccess(false) }}
                autoComplete="current-password" />
              {emailError   && <p role="alert" className="text-sm text-red-600">{emailError}</p>}
              {emailSuccess && <p role="status" className="text-sm text-green-700">Confirmation email sent to your new address. Your current email stays active until you confirm.</p>}
              <Button type="submit" loading={emailLoading} variant="secondary" size="sm" className="self-start">
                {user?.pendingEmail ? 'Request a different change' : 'Update email'}
              </Button>
            </Form>
          </div>
        </div>

        {/* Change password */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="font-semibold text-gray-900 mb-4">Change password</h2>
          <Form onSubmit={handleChangePassword} className="flex flex-col gap-3">
            <PasswordInput label="Current password" value={current}
              onChange={e => { setCurrent(e.target.value); setPwSuccess(false) }} autoComplete="current-password" />
            <PasswordInput label="New password" value={newPass}
              onChange={e => { setNewPass(e.target.value); setPwSuccess(false) }} autoComplete="new-password"
              placeholder="Min. 8 characters" />
            <PasswordInput label="Confirm new password" value={confirm}
              onChange={e => { setConfirm(e.target.value); setPwSuccess(false) }} autoComplete="new-password" />
            {pwError   && <p role="alert" className="text-sm text-red-600">{pwError}</p>}
            {pwSuccess && <p role="status" className="text-sm text-green-700">Password updated. Other sessions signed out.</p>}
            <Button type="submit" loading={pwLoading} variant="secondary" className="self-start">
              Update password
            </Button>
          </Form>
        </div>

        {/* Sign out other sessions */}
        {/* FEATURE (Auth section audit): previously the only way to kill
            sessions on other devices was as a side effect of changing the
            password — no option for "just sign out that lost/stolen phone,
            nothing else wrong". */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="font-semibold text-gray-900 mb-1">Sign out other sessions</h2>
          <p className="text-sm text-gray-500 mb-4">
            Signs every other device and browser out, without changing your password.
            This browser stays signed in.
          </p>
          {/* FEATURE (Auth section, feature-gap-closing pass): pairs the
              button above with the one signal that actually helps someone
              decide whether to click it. Deliberately "previous" sign-in,
              not "last" — by the time this page loads, "last" is always
              THIS session, which would always read "just now" and tell you
              nothing. Absent (older accounts, or someone's very first sign-in
              since this shipped) means there's nothing to compare against yet. */}
          {user?.previousLoginAt && (
            <p className="text-xs text-gray-500 mb-4">
              Previous sign-in: {formatDateTime(user.previousLoginAt)}
              {user?.previousLoginIp && <> from <span className="font-mono">{user.previousLoginIp}</span></>}
              . Don't recognize it? Change your password below, then sign out other sessions.
            </p>
          )}
          {signOutError   && <p role="alert" className="text-sm text-red-600 mb-3">{signOutError}</p>}
          {signOutSuccess && <p role="status" className="text-sm text-green-700 mb-3">Other sessions signed out.</p>}
          <Button type="button" loading={signOutLoading} variant="secondary"
            onClick={handleSignOutOtherSessions}>
            Sign out other sessions
          </Button>
        </div>

        {/* FEATURE GAP CLOSED (Auth round 2): per-device list + sign-out */}
        <SessionsCard reloadKey={sessionsReload} />

        {/* Email preferences: only the "your scan finished" result email is optional. */}
        {notifyScanResults !== null && (
          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <h2 className="font-semibold text-gray-900 mb-1">Email</h2>
            <Checkbox
              checked={notifyScanResults}
              disabled={prefSaving}
              onChange={handleToggleNotify}
              label={<span className="font-medium text-gray-900">Email me when a scan finishes</span>}
              description="The score summary after each scan. Security notices, receipts and your delivered fix are always sent."
            />
            {prefError && <p role="alert" className="text-sm text-red-600 mt-2">{prefError}</p>}
          </div>
        )}

        {/* Saved profile */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="font-semibold text-gray-900 mb-1">Saved profile</h2>
          <p className="text-sm text-gray-500 mb-4">
            Used to translate your background against a new job description in one step,
            without re-uploading a resume. Saving another scan's profile replaces this one.
          </p>
          {profileLoading ? (
            <p className="text-sm text-gray-400">Loading…</p>
          ) : profileError ? (
            <div role="alert" className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <p className="text-sm text-red-600">{profileError}</p>
              <Button variant="secondary" size="sm" onClick={() => loadProfile()}>Try again</Button>
            </div>
          ) : hasSavedProfile ? (
            <>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <p className="text-sm text-gray-600">
                  Saved {savedAt ? formatDate(savedAt) : ''}{editedAt ? `, edited ${formatDate(editedAt)}` : ''}
                  {profileSummary?.name && <> — <span className="font-medium">{profileSummary.name}</span></>}
                  {profileSummary?.roleCategory && (
                    // roleLabel() like every other place that shows a role category.
                    <span className="text-gray-400"> ({roleLabel(profileSummary.roleCategory)})</span>
                  )}
                </p>
                {profileSummary && (
                  <p className="text-xs text-gray-500 mt-0.5">
                    {[
                      profileSummary.latestTitle && `Latest role: ${profileSummary.latestTitle}`,
                      profileSummary.jobCount > 0 && `${profileSummary.jobCount} job${profileSummary.jobCount === 1 ? '' : 's'}`,
                      profileSummary.educationCount > 0 && `${profileSummary.educationCount} education entr${profileSummary.educationCount === 1 ? 'y' : 'ies'}`,
                      profileSummary.skillCount > 0 && `${profileSummary.skillCount} skill${profileSummary.skillCount === 1 ? '' : 's'}`,
                    ].filter(Boolean).join(' · ')}
                  </p>
                )}
                {sourceScanId && (
                  <Link to={`/scan/${sourceScanId}`} className="text-xs text-blue-600 hover:underline">
                    View source scan
                  </Link>
                )}
              </div>
              <div className="flex flex-wrap gap-2 shrink-0">
                <Link to="/?mode=savedProfile"
                  className="inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium bg-blue-700 hover:bg-blue-800 text-white">
                  Scan against a new job
                </Link>
                {!editingProfile && (
                  <Button variant="secondary" size="sm" onClick={() => setEditingProfile(true)}>Edit</Button>
                )}
                <Button variant="secondary" size="sm" onClick={() => downloadProfileFile('docx', null, profileSummary?.name)}
                  loading={downloadingFile === 'primary:docx'} disabled={!!downloadingFile}>Download .docx</Button>
                <Button variant="secondary" size="sm" onClick={() => downloadProfileFile('pdf', null, profileSummary?.name)}
                  loading={downloadingFile === 'primary:pdf'} disabled={!!downloadingFile}>Download PDF</Button>
                <Button variant="secondary" onClick={() => { setRemoveError(''); setRemoveConfirmOpen(true) }} size="sm">
                  Remove saved profile
                </Button>
              </div>
            </div>
            {editingProfile && (
              <SavedProfileEditor onSaved={() => loadProfile({ quiet: true })} onClose={() => setEditingProfile(false)} />
            )}
            </>
          ) : extraProfiles.length === 0 ? (
            <p className="text-sm text-gray-400">
              No saved profile yet — you can save one from any completed scan.
            </p>
          ) : null}

          {extraProfiles.length > 0 && (
            <div className="mt-5 border-t border-gray-100 pt-4">
              <h3 className="text-sm font-semibold text-gray-900">Other profiles</h3>
              <p className="text-xs text-gray-500 mb-3">
                Pick any of them when you scan against a new job. {extraProfiles.length} of {maxExtras} used — save more from a completed scan with “Keep as another profile”.
              </p>
              <ul className="flex flex-col gap-3">
                {extraProfiles.map(p => (
                  <li key={p.id} className="rounded-md border border-gray-200 px-4 py-3">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="min-w-0">
                        {renameId === p.id ? (
                          <form className="flex items-center gap-2" onSubmit={e => { e.preventDefault(); handleRenameExtra(p.id) }}>
                            <input type="text" value={renameValue} onChange={e => setRenameValue(e.target.value)} maxLength={40}
                              aria-label="Profile name" className="rounded-md border border-gray-300 px-2 py-1 text-sm" />
                            <Button type="submit" size="sm" loading={extraBusy}>Save</Button>
                            <Button type="button" size="sm" variant="secondary" onClick={() => setRenameId(null)}>Cancel</Button>
                          </form>
                        ) : (
                          <p className="text-sm font-medium text-gray-900 truncate">{p.label}</p>
                        )}
                        <p className="text-xs text-gray-500 mt-0.5">
                          {[
                            p.summary?.name,
                            p.summary?.latestTitle && `Latest role: ${p.summary.latestTitle}`,
                            p.summary?.jobCount > 0 && `${p.summary.jobCount} job${p.summary.jobCount === 1 ? '' : 's'}`,
                            `saved ${formatDate(p.savedAt)}${p.editedAt ? `, edited ${formatDate(p.editedAt)}` : ''}`,
                          ].filter(Boolean).join(' · ')}
                        </p>
                        {p.sourceScanId && (
                          <Link to={`/scan/${p.sourceScanId}`} className="text-xs text-blue-600 hover:underline">View source scan</Link>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2 shrink-0">
                        {editingExtraId !== p.id && <Button variant="secondary" size="sm" onClick={() => setEditingExtraId(p.id)}>Edit</Button>}
                        <Button variant="secondary" size="sm" onClick={() => { setRenameId(p.id); setRenameValue(p.label) }}>Rename</Button>
                        <Button variant="secondary" size="sm" onClick={() => downloadProfileFile('docx', p.id, p.label)}
                          loading={downloadingFile === `${p.id}:docx`} disabled={!!downloadingFile}>.docx</Button>
                        <Button variant="secondary" size="sm" onClick={() => downloadProfileFile('pdf', p.id, p.label)}
                          loading={downloadingFile === `${p.id}:pdf`} disabled={!!downloadingFile}>PDF</Button>
                        <Button variant="secondary" size="sm" onClick={() => { setExtraError(''); setRemoveExtraTarget(p) }}>Remove</Button>
                      </div>
                    </div>
                    {editingExtraId === p.id && (
                      <SavedProfileEditor profileId={p.id} onSaved={() => loadProfile({ quiet: true })} onClose={() => setEditingExtraId(null)} />
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {extraError && <p role="alert" className="text-sm text-red-600 mt-2">{extraError}</p>}
          {removeError && <p role="alert" className="text-sm text-red-600 mt-2">{removeError}</p>}
        </div>

        {/* Your data */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="font-semibold text-gray-900 mb-1">Your data</h2>
          <p className="text-sm text-gray-500 mb-4">
            Download a copy of what we hold for your account — profile and settings, sign-in history and signed-in
            devices, scans (including job descriptions, the structured data extracted from your resumes and the analysis
            of each one), payment history with any refunds, and a list of the emails we've sent you at your current address — as JSON. The uploaded resume files and generated
            documents themselves aren't included (the data extracted from them is); documents you purchased stay downloadable from each scan's page. Accounts with many scans are
            split into several files.
          </p>
          <Button variant="secondary" size="sm" onClick={handleExport} loading={exporting} disabled={exportingPart !== 0}>
            {exportParts > 1 ? 'Download part 1 again' : 'Download my data'}
          </Button>
          {exportParts > 1 && (
            <div role="status" className="mt-4 text-sm text-gray-600">
              <p className="mb-2">
                Your data is split into <strong>{exportParts} files</strong> — each one holds a batch of your scans, and the first also holds your
                account, saved profile, devices, email history and payments. Part 1 is downloaded; download the rest{cursorMode ? ', in order,' : ''} to have everything:
              </p>
              <div className="flex flex-wrap gap-2">
                {Array.from({ length: exportParts - 1 }, (_, i) => i + 2).map(part => (
                  <Button key={part} variant="secondary" size="sm" loading={exportingPart === part}
                    disabled={exporting || (exportingPart !== 0 && exportingPart !== part) || (cursorMode && !exportCursors[part])} onClick={() => downloadExportPart(part)}>
                    {exportedParts.includes(part) ? `✓ Part ${part} of ${exportParts}` : `Part ${part} of ${exportParts}`}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {exportError && <p role="alert" className="text-sm text-red-600 mt-2">{exportError}</p>}
        </div>

        {/* Delete scan history */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="font-semibold text-gray-900 mb-1">Scan history</h2>
          <p className="text-sm text-gray-500 mb-4">
            Delete every scan — resume text, job descriptions and rewritten documents — without closing your account.
            Payment records and your saved profile are kept.
          </p>
          <Button variant="secondary" size="sm" onClick={() => { setPurgeError(''); setPurgeResult(null); setPurgeOpen(true) }}>
            Delete my scan history
          </Button>
          {purgeError && <p role="alert" className="text-sm text-red-600 mt-2">{purgeError}</p>}
          {purgeResult && (
            <p role="status" className="text-sm text-gray-700 mt-2">
              {purgeResult.deleted === 0 && purgeResult.remaining === 0
                ? 'You have no scans to delete.'
                : `Deleted ${purgeResult.deleted} scan${purgeResult.deleted === 1 ? '' : 's'}.`}
              {purgeResult.remaining > 0 && ` ${purgeResult.remaining} ${purgeResult.remaining === 1 ? 'is' : 'are'} still being processed and ${purgeResult.remaining === 1 ? 'was' : 'were'} kept — try again in a few minutes.`}
            </p>
          )}
        </div>

        {/* Danger zone */}
        <div className="bg-white rounded-lg border border-red-200 p-6">
          <h2 className="font-semibold text-red-800 mb-2">Danger zone</h2>
          <p className="text-sm text-gray-500 mb-4">
            Permanently delete your account and the data attached to it. This cannot be undone.
          </p>
          <Button variant="danger" onClick={() => setDeleteOpen(true)}>
            Delete account
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={purgeOpen}
        title="Delete scan history"
        message={purging
          ? `Deleting… ${purgeCount} scan${purgeCount === 1 ? '' : 's'} removed so far.`
          : 'Permanently delete your whole scan history? Every scan\'s resume file, job description and rewritten documents are removed, and any public verification page you purchased stops working. Your payment records, saved profile and account stay.\n\nScans that are still being processed are skipped.'}
        confirmLabel="Delete all scans"
        loading={purging}
        onConfirm={handlePurgeHistory}
        onCancel={() => setPurgeOpen(false)}
      />

      <ConfirmDialog
        open={!!removeExtraTarget}
        title="Remove profile"
        message={removeExtraTarget ? `Remove “${removeExtraTarget.label}”? You can save it again from a completed scan.` : ''}
        confirmLabel="Remove"
        loading={extraBusy}
        onConfirm={handleRemoveExtra}
        onCancel={() => setRemoveExtraTarget(null)}
      />

      <ConfirmDialog
        open={removeConfirmOpen}
        title="Remove saved profile"
        message="Remove your saved profile? You'll need to save it again from a completed scan to reuse it for a rescan."
        confirmLabel="Remove"
        loading={removing}
        onConfirm={handleRemoveProfile}
        onCancel={() => setRemoveConfirmOpen(false)}
      />

      <Modal open={cancelOpen} onClose={closeCancel} title="Cancel email change" dismissible={!cancelingPending}>
        <p className="text-sm text-gray-600 mb-4">
          Enter your password to cancel the pending change{user?.pendingEmail ? <> to <strong>{user.pendingEmail}</strong></> : ''}.
        </p>
        <Form onSubmit={handleCancelPendingEmail} className="flex flex-col gap-3">
          <PasswordInput placeholder="Your password" value={cancelPassword}
            autoComplete="current-password" onChange={e => setCancelPassword(e.target.value)} />
          {cancelError && <p role="alert" className="text-sm text-red-600">{cancelError}</p>}
          <div className="flex gap-3">
            <Button variant="secondary" onClick={closeCancel} disabled={cancelingPending} className="flex-1">
              Keep the change
            </Button>
            <Button type="submit" loading={cancelingPending} className="flex-1">Cancel change</Button>
          </div>
        </Form>
      </Modal>

      <Modal open={deleteOpen} onClose={closeDelete} title="Delete account" dismissible={!deleteLoading}>
        <div className="text-sm text-gray-600 mb-4 flex flex-col gap-2">
          <p>This permanently deletes your account, your scans, resumes and rewritten documents, and your saved profile.</p>
          <ul className="list-disc pl-5 flex flex-col gap-1">
            <li>Any public verification link you purchased stops working.</li>
            {user?.freeFixCredits > 0 && (
              <li>Your {user.freeFixCredits} unused free fix credit{user.freeFixCredits === 1 ? '' : 's'} will be lost.</li>
            )}
            <li>Payment records are kept for accounting, as described in our Privacy Policy.</li>
          </ul>
          <p>Want a copy first? Close this and use “Download my data”. Enter your password to confirm.</p>
        </div>
        <Form onSubmit={handleDeleteAccount} className="flex flex-col gap-3">
          <PasswordInput placeholder="Your password" value={deletePass}
            autoComplete="current-password" onChange={e => setDeletePass(e.target.value)} />
          {deleteError && <p role="alert" className="text-sm text-red-600">{deleteError}</p>}
          <div className="flex gap-3">
            <Button variant="secondary" onClick={closeDelete} disabled={deleteLoading} className="flex-1">
              Cancel
            </Button>
            <Button type="submit" variant="danger" loading={deleteLoading} className="flex-1">
              Delete permanently
            </Button>
          </div>
        </Form>
      </Modal>
    </DashboardLayout>
  )
}
