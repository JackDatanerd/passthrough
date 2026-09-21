import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../../lib/api'
import { useApi } from '../../hooks/useApi'
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
  const [nameSuccess,  setNameSuccess ] = useState(false)
  const { loading: nameLoading, error: nameError, execute: executeName } = useApi()

  const [newEmail,      setNewEmail     ] = useState('')
  const [emailPassword, setEmailPassword] = useState('')
  const [emailSuccess,  setEmailSuccess ] = useState(false)
  const { loading: emailLoading, error: emailError, execute: executeEmail } = useApi()

  // AUDIT FIX: the "Email verified: No" status here was inert text with no
  // way to act on it — the actual resend-verification button only existed
  // on dashboard/Index.jsx. Same request/refresh pattern as that one.
  const [resentOk,  setResentOk ] = useState(false)
  const { loading: resending, error: resendError, execute: executeResend, reset: resetResend } = useApi()

  async function handleResendVerification() {
    try {
      await executeResend(() => api.post('/auth/resend-verification'),
        { fallback: 'Could not resend verification email.' })
      setResentOk(true)
      refreshUser()
    } catch (_) { /* error already captured by useApi */ }
  }

  useEffect(() => {
    if (user?.name) setName(user.name)
  }, [user?.name])

  async function handleUpdateName() {
    if (!name.trim()) {
      await executeName(() => Promise.reject(new Error('Name is required.')),
        { fallback: 'Name is required.' }).catch(() => {})
      return
    }
    setNameSuccess(false)
    try {
      await executeName(() => api.patch('/auth/name', { name: name.trim() }),
        { fallback: 'Failed to update name.' })
      await refreshUser()
      setNameSuccess(true)
    } catch (_) { /* error already captured by useApi */ }
  }

  async function handleUpdateEmail() {
    if (!newEmail || !emailPassword) {
      await executeEmail(() => Promise.reject(new Error('New email and password required.')),
        { fallback: 'New email and password required.' }).catch(() => {})
      return
    }
    setEmailSuccess(false)
    try {
      await executeEmail(() => api.patch('/auth/email', { newEmail, password: emailPassword }),
        { fallback: 'Failed to update email.' })
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
      setResentOk(false); resetResend()
    } catch (_) { /* error already captured by useApi */ }
  }

  // Change password
  const [current,  setCurrent ] = useState('')
  const [newPass,  setNewPass ] = useState('')
  const [confirm,  setConfirm ] = useState('')
  const [pwSuccess, setPwSuccess] = useState(false)
  const { loading: pwLoading, error: pwError, execute: executePw } = useApi()

  // PHASE 4 — saved profile management. Closes the consent loop: saving a
  // profile (ScanResult.jsx / SaveProfilePrompt) is an explicit opt-in, so
  // removing it needs to be just as easy, without going all the way to
  // deleting the whole account.
  const [profileLoading, setProfileLoading] = useState(true)
  const [hasSavedProfile, setHasSavedProfile] = useState(false)
  const [savedAt,         setSavedAt        ] = useState(null)
  const { loading: removing, error: removeError, execute: executeRemove } = useApi()

  useEffect(() => {
    api.get('/profile')
      .then(res => {
        setHasSavedProfile(!!res.data.data.hasSavedProfile)
        setSavedAt(res.data.data.savedAt)
      })
      .catch(() => {})
      .finally(() => setProfileLoading(false))

    // Same stale-cache fix as Dashboard/Index.jsx — see that file's comment.
    refreshUser()
  }, [])

  async function handleRemoveProfile() {
    try {
      await executeRemove(() => api.delete('/profile'), { fallback: 'Failed to remove saved profile.' })
      setHasSavedProfile(false)
      setSavedAt(null)
    } catch (_) { /* error already captured by useApi */ }
  }

  // Delete account
  const [deleteOpen,    setDeleteOpen   ] = useState(false)
  const [deletePass,    setDeletePass   ] = useState('')
  const { loading: deleteLoading, error: deleteError, execute: executeDelete, reset: resetDelete } = useApi()

  async function handleChangePassword() {
    if (!current || !newPass) {
      await executePw(() => Promise.reject(new Error('All fields required.')),
        { fallback: 'All fields required.' }).catch(() => {})
      return
    }
    if (newPass.length < 8) {
      await executePw(() => Promise.reject(new Error('New password must be at least 8 characters.')),
        { fallback: 'New password must be at least 8 characters.' }).catch(() => {})
      return
    }
    if (newPass !== confirm) {
      await executePw(() => Promise.reject(new Error('Passwords do not match.')),
        { fallback: 'Passwords do not match.' }).catch(() => {})
      return
    }
    setPwSuccess(false)
    try {
      const data = await executePw(() => api.patch('/auth/password', { currentPassword: current, newPassword: newPass }),
        { fallback: 'Failed to update password.' })
      // BUG FIX: changePassword invalidates every existing token (including
      // this tab's) and now returns a freshly-signed one — store it so this
      // session survives, matching what the success message already says
      // ("Other sessions signed out"). Without this, the very next request
      // anywhere in the app 401'd and silently bounced to /login, right
      // after this screen told the user everything was fine.
      const token = data?.data?.token
      if (token) localStorage.setItem('passthrough_token', token)
      setPwSuccess(true)
      setCurrent(''); setNewPass(''); setConfirm('')
    } catch (_) { /* error already captured by useApi */ }
  }

  // Closing the dialog must also clear what was typed into it — the password
  // and any error used to linger in state and reappear on the next open.
  function closeDelete() {
    if (deleteLoading) return
    setDeleteOpen(false); setDeletePass(''); resetDelete()
  }

  async function handleDeleteAccount() {
    if (!deletePass) {
      await executeDelete(() => Promise.reject(new Error('Password required.')),
        { fallback: 'Password required.' }).catch(() => {})
      return
    }
    try {
      await executeDelete(() => api.delete('/auth/account', { data: { password: deletePass } }),
        { fallback: 'Failed to delete account.' })
      logout()
      navigate('/')
    } catch (_) { /* error already captured by useApi */ }
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
              <p className="text-sm text-gray-600">
                Saved {savedAt ? formatDate(savedAt) : ''}
              </p>
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
