import { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import api, { getErrorMessage } from '../../lib/api'
import { useAuth } from '../../hooks/useAuth'
import DashboardLayout from '../../components/layout/DashboardLayout'
import Button from '../../components/ui/Button'
import Form from '../../components/ui/Form'
import Input from '../../components/ui/Input'
import Modal from '../../components/ui/Modal'
import { formatDate } from '../../lib/utils'

export default function Settings() {
  const navigate      = useNavigate()
  const { user, logout, refreshUser } = useAuth()

  // AUDIT FIX (Section 6): Account previously showed name/email as static
  // text with no way to ever change either — no endpoint existed for it.
  const [name,        setName       ] = useState('')
  const [nameLoading,  setNameLoading ] = useState(false)
  const [nameError,    setNameError   ] = useState('')
  const [nameSuccess,  setNameSuccess ] = useState(false)

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
      setResendError(err.response?.data?.message || 'Could not resend verification email.')
    } finally {
      setResending(false)
    }
  }

  useEffect(() => {
    if (user?.name) setName(user.name)
  }, [user?.name])

  async function handleUpdateName() {
    if (!name.trim()) return setNameError('Name is required.')
    setNameLoading(true); setNameError(''); setNameSuccess(false)
    try {
      await api.patch('/auth/name', { name: name.trim() })
      await refreshUser()
      setNameSuccess(true)
    } catch (err) {
      setNameError(getErrorMessage(err, 'Failed to update name.'))
    } finally {
      setNameLoading(false)
    }
  }

  async function handleUpdateEmail() {
    if (!newEmail || !emailPassword) return setEmailError('New email and password required.')
    setEmailLoading(true); setEmailError(''); setEmailSuccess(false)
    try {
      await api.patch('/auth/email', { newEmail, password: emailPassword })
      await refreshUser()
      setEmailSuccess(true)
      setNewEmail(''); setEmailPassword('')
      // BUG FIX (Section 6): resentOk/resendError belong to the resend-
      // verification button just above, keyed on whatever address is
      // CURRENTLY unverified. Changing the email address here marks the
      // NEW address unverified (updateEmail already fires one verification
      // email automatically) — but without resetting these, a user who'd
      // clicked "Resend" earlier for their OLD address would keep seeing
      // the stale "Sent!" badge here instead of a live resend button, for
      // an address that never actually had a resend click of its own.
      setResentOk(false); setResendError('')
    } catch (err) {
      setEmailError(getErrorMessage(err, 'Failed to update email.'))
    } finally {
      setEmailLoading(false)
    }
  }

  // Change password
  const [current,  setCurrent ] = useState('')
  const [newPass,  setNewPass ] = useState('')
  const [confirm,  setConfirm ] = useState('')
  const [pwLoading, setPwLoading] = useState(false)
  const [pwError,   setPwError  ] = useState('')
  const [pwSuccess, setPwSuccess] = useState(false)

  // PHASE 4 — saved profile management. Closes the consent loop: saving a
  // profile (ScanResult.jsx / SaveProfilePrompt) is an explicit opt-in, so
  // removing it needs to be just as easy, without going all the way to
  // deleting the whole account.
  const [profileLoading, setProfileLoading] = useState(true)
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

  useEffect(() => {
    api.get('/profile')
      .then(res => {
        setHasSavedProfile(!!res.data.data.hasSavedProfile)
        setSavedAt(res.data.data.savedAt)
        setSourceScanId(res.data.data.sourceScanId)
        setProfileSummary(res.data.data.summary)
      })
      .catch(() => {})
      .finally(() => setProfileLoading(false))

    // Same stale-cache fix as Dashboard/Index.jsx — see that file's comment.
    refreshUser()
  }, [])

  async function handleRemoveProfile() {
    setRemoving(true); setRemoveError('')
    try {
      await api.delete('/profile')
      setHasSavedProfile(false)
      setSavedAt(null)
      setSourceScanId(null)
      setProfileSummary(null)
    } catch (err) {
      setRemoveError(getErrorMessage(err, 'Failed to remove saved profile.'))
    } finally {
      setRemoving(false)
    }
  }

  // Delete account
  const [deleteOpen,    setDeleteOpen   ] = useState(false)
  const [deletePass,    setDeletePass   ] = useState('')
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [deleteError,   setDeleteError  ] = useState('')

  async function handleChangePassword() {
    if (!current || !newPass) return setPwError('All fields required.')
    if (newPass.length < 8) return setPwError('New password must be at least 8 characters.')
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
                  {resendError && <p className="text-sm text-red-600">{resendError}</p>}
                </div>
              )}
            </div>

            <Form onSubmit={handleUpdateName} className="flex flex-col sm:flex-row gap-2 sm:items-end">
              <Input label="Name" value={name} autoComplete="name" onChange={e => { setName(e.target.value); setNameSuccess(false) }} />
              <Button type="submit" loading={nameLoading} variant="secondary" size="sm">
                Save
              </Button>
            </Form>
            {nameError   && <p className="text-sm text-red-600">{nameError}</p>}
            {nameSuccess && <p className="text-sm text-green-700">Name updated.</p>}

            <Form onSubmit={handleUpdateEmail} className="flex flex-col gap-2 pt-2 border-t border-gray-100">
              <p className="text-sm text-gray-600"><span className="font-medium">Current email:</span> {user?.email}</p>
              <Input label="New email" type="email" value={newEmail}
                onChange={e => { setNewEmail(e.target.value); setEmailSuccess(false) }} />
              <Input label="Password" type="password" value={emailPassword}
                onChange={e => { setEmailPassword(e.target.value); setEmailSuccess(false) }}
                autoComplete="current-password" />
              {emailError   && <p className="text-sm text-red-600">{emailError}</p>}
              {emailSuccess && <p className="text-sm text-green-700">Email updated — check your inbox to verify it.</p>}
              <Button type="submit" loading={emailLoading} variant="secondary" size="sm" className="self-start">
                Update email
              </Button>
            </Form>
          </div>
        </div>

        {/* Change password */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="font-semibold text-gray-900 mb-4">Change password</h2>
          <Form onSubmit={handleChangePassword} className="flex flex-col gap-3">
            <Input label="Current password" type="password" value={current}
              onChange={e => setCurrent(e.target.value)} autoComplete="current-password" />
            <Input label="New password" type="password" value={newPass}
              onChange={e => setNewPass(e.target.value)} autoComplete="new-password"
              placeholder="Min. 8 characters" />
            <Input label="Confirm new password" type="password" value={confirm}
              onChange={e => setConfirm(e.target.value)} autoComplete="new-password" />
            {pwError   && <p className="text-sm text-red-600">{pwError}</p>}
            {pwSuccess && <p className="text-sm text-green-700">Password updated. Other sessions signed out.</p>}
            <Button type="submit" loading={pwLoading} variant="secondary" className="self-start">
              Update password
            </Button>
          </Form>
        </div>

        {/* Saved profile */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="font-semibold text-gray-900 mb-1">Saved profile</h2>
          <p className="text-sm text-gray-500 mb-4">
            Used to translate your background against a new job description in one step,
            without re-uploading a resume.
          </p>
          {profileLoading ? (
            <p className="text-sm text-gray-400">Loading…</p>
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
                {sourceScanId && (
                  <Link to={`/scan/${sourceScanId}`} className="text-xs text-blue-600 hover:underline">
                    View source scan
                  </Link>
                )}
              </div>
              <Button variant="secondary" onClick={handleRemoveProfile} loading={removing} size="sm">
                Remove saved profile
              </Button>
            </div>
          ) : (
            <p className="text-sm text-gray-400">
              No saved profile yet — you can save one from any completed scan.
            </p>
          )}
          {removeError && <p className="text-sm text-red-600 mt-2">{removeError}</p>}
        </div>

        {/* Danger zone */}
        <div className="bg-white rounded-lg border border-red-200 p-6">
          <h2 className="font-semibold text-red-800 mb-2">Danger zone</h2>
          <p className="text-sm text-gray-500 mb-4">
            Permanently delete your account and all associated data. This cannot be undone.
          </p>
          <Button variant="danger" onClick={() => setDeleteOpen(true)}>
            Delete account
          </Button>
        </div>
      </div>

      <Modal open={deleteOpen} onClose={closeDelete} title="Delete account" dismissible={!deleteLoading}>
        <p className="text-sm text-gray-600 mb-4">
          This will permanently delete your account. Enter your password to confirm.
        </p>
        <Form onSubmit={handleDeleteAccount} className="flex flex-col gap-3">
          <Input type="password" placeholder="Your password" value={deletePass}
            autoComplete="current-password" onChange={e => setDeletePass(e.target.value)} />
          {deleteError && <p className="text-sm text-red-600">{deleteError}</p>}
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
