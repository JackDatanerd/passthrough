import { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import api, { getErrorMessage } from '../../lib/api'
import { useAuth } from '../../hooks/useAuth'
import DashboardLayout from '../../components/layout/DashboardLayout'
import Button from '../../components/ui/Button'
import Form from '../../components/ui/Form'
import Input from '../../components/ui/Input'
import Modal from '../../components/ui/Modal'
import ConfirmDialog from '../../components/ui/ConfirmDialog'
import { formatDate, formatDateTime } from '../../lib/utils'
import { exportFileName, exportPartsFrom } from '../../lib/dataExport'
import { passwordProblem } from '../../lib/passwordRules'

export default function Settings() {
  const navigate      = useNavigate()
  const { user, logout, refreshUser } = useAuth()

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
    } finally {
      setResending(false)
    }
  }

  useEffect(() => {
    if (user?.name && !nameDirty) setName(user.name)
  }, [user?.name, nameDirty])

  async function handleUpdateName() {
    if (!name.trim()) return setNameError('Name is required.')
    setNameLoading(true); setNameError(''); setNameSuccess(false)
    try {
      await api.patch('/auth/name', { name: name.trim() })
      setNameDirty(false)
      await refreshUser()
      setNameSuccess(true)
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

  function loadProfile() {
    setProfileLoading(true); setProfileError('')
    return api.get('/profile')
      .then(res => {
        setHasSavedProfile(!!res.data.data.hasSavedProfile)
        setSavedAt(res.data.data.savedAt)
        setSourceScanId(res.data.data.sourceScanId)
        setProfileSummary(res.data.data.summary)
      })
      .catch(err => setProfileError(getErrorMessage(err, "Couldn't check your saved profile.")))
      .finally(() => setProfileLoading(false))
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
      setProfileSummary(null)
      setRemoveConfirmOpen(false)
    } catch (err) {
      setRemoveError(getErrorMessage(err, 'Failed to remove saved profile.'))
      setRemoveConfirmOpen(false)
    } finally {
      setRemoving(false)
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

  async function downloadExportPart(part) {
    setExportError('')
    part === 1 ? setExporting(true) : setExportingPart(part)
    try {
      const res = await api.get('/profile/export', { params: { part }, responseType: 'blob' })
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url; a.download = exportFileName(part)
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      if (part === 1) { setExportParts(await exportPartsFrom(res)); setExportedParts([1]) }
      else setExportedParts(prev => prev.includes(part) ? prev : [...prev, part])
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
      if (token) localStorage.setItem('passthrough_token', token)
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
      if (token) localStorage.setItem('passthrough_token', token)
      setSignOutSuccess(true)
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
                  <span>Confirmation pending for <strong>{user.pendingEmail}</strong> — check that inbox.</span>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setCancelOpen(true)}>
                    Cancel
                  </Button>
                </div>
              )}
              <Input label="New email" type="email" value={newEmail}
                onChange={e => { setNewEmail(e.target.value); setEmailSuccess(false) }} />
              <Input label="Password" type="password" value={emailPassword}
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
            <Input label="Current password" type="password" value={current}
              onChange={e => { setCurrent(e.target.value); setPwSuccess(false) }} autoComplete="current-password" />
            <Input label="New password" type="password" value={newPass}
              onChange={e => { setNewPass(e.target.value); setPwSuccess(false) }} autoComplete="new-password"
              placeholder="Min. 8 characters" />
            <Input label="Confirm new password" type="password" value={confirm}
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
              <Button variant="secondary" size="sm" onClick={loadProfile}>Try again</Button>
            </div>
          ) : hasSavedProfile ? (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <p className="text-sm text-gray-600">
                  Saved {savedAt ? formatDate(savedAt) : ''}
                  {profileSummary?.name && <> — <span className="font-medium">{profileSummary.name}</span></>}
                  {profileSummary?.roleCategory && (
                    <span className="text-gray-400"> ({profileSummary.roleCategory.replace(/_/g, ' ').toLowerCase()})</span>
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
              <Button variant="secondary" onClick={() => { setRemoveError(''); setRemoveConfirmOpen(true) }} size="sm">
                Remove saved profile
              </Button>
            </div>
          ) : (
            <p className="text-sm text-gray-400">
              No saved profile yet — you can save one from any completed scan.
            </p>
          )}
          {removeError && <p role="alert" className="text-sm text-red-600 mt-2">{removeError}</p>}
        </div>

        {/* Your data */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="font-semibold text-gray-900 mb-1">Your data</h2>
          <p className="text-sm text-gray-500 mb-4">
            Download a copy of what we hold for your account — profile, scans (including job descriptions and
            the text and structured data of your resumes), and payment history — as JSON. The uploaded resume
            files and generated documents themselves aren't included; the data extracted from them is. Accounts
            with many scans are split into several files.
          </p>
          <Button variant="secondary" size="sm" onClick={handleExport} loading={exporting} disabled={exportingPart !== 0}>
            {exportParts > 1 ? 'Download part 1 again' : 'Download my data'}
          </Button>
          {exportParts > 1 && (
            <div role="status" className="mt-4 text-sm text-gray-600">
              <p className="mb-2">
                Your data is split into <strong>{exportParts} files</strong> — each one holds up to 500 scans, and the first also holds your
                account, saved profile and payments. Part 1 is downloaded; download the rest to have everything:
              </p>
              <div className="flex flex-wrap gap-2">
                {Array.from({ length: exportParts - 1 }, (_, i) => i + 2).map(part => (
                  <Button key={part} variant="secondary" size="sm" loading={exportingPart === part}
                    disabled={exporting || (exportingPart !== 0 && exportingPart !== part)} onClick={() => downloadExportPart(part)}>
                    {exportedParts.includes(part) ? `✓ Part ${part} of ${exportParts}` : `Part ${part} of ${exportParts}`}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {exportError && <p role="alert" className="text-sm text-red-600 mt-2">{exportError}</p>}
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
          <Input type="password" placeholder="Your password" value={cancelPassword}
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
          <Input type="password" placeholder="Your password" value={deletePass}
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
