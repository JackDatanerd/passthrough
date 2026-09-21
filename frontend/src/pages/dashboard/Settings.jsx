import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../../lib/api'
import { useAuth } from '../../hooks/useAuth'
import DashboardLayout from '../../components/layout/DashboardLayout'
import Button from '../../components/ui/Button'
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
      setNameError(err.response?.data?.message || 'Failed to update name.')
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
    } catch (err) {
      setEmailError(err.response?.data?.message || 'Failed to update email.')
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
  const [removing,        setRemoving       ] = useState(false)
  const [removeError,     setRemoveError    ] = useState('')

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
    setRemoving(true); setRemoveError('')
    try {
      await api.delete('/profile')
      setHasSavedProfile(false)
      setSavedAt(null)
    } catch (err) {
      setRemoveError(err.response?.data?.message || 'Failed to remove saved profile.')
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
      setPwError(err.response?.data?.message || 'Failed to update password.')
    } finally {
      setPwLoading(false)
    }
  }

  async function handleDeleteAccount() {
    if (!deletePass) return setDeleteError('Password required.')
    setDeleteLoading(true); setDeleteError('')
    try {
      await api.delete('/auth/account', { data: { password: deletePass } })
      logout()
      navigate('/')
    } catch (err) {
      setDeleteError(err.response?.data?.message || 'Failed to delete account.')
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

            <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
              <Input label="Name" value={name} onChange={e => { setName(e.target.value); setNameSuccess(false) }} />
              <Button onClick={handleUpdateName} loading={nameLoading} variant="secondary" size="sm">
                Save
              </Button>
            </div>
            {nameError   && <p className="text-sm text-red-600">{nameError}</p>}
            {nameSuccess && <p className="text-sm text-green-700">Name updated.</p>}

            <div className="flex flex-col gap-2 pt-2 border-t border-gray-100">
              <p className="text-sm text-gray-600"><span className="font-medium">Current email:</span> {user?.email}</p>
              <Input label="New email" type="email" value={newEmail}
                onChange={e => { setNewEmail(e.target.value); setEmailSuccess(false) }} />
              <Input label="Password" type="password" value={emailPassword}
                onChange={e => { setEmailPassword(e.target.value); setEmailSuccess(false) }}
                autoComplete="current-password" />
              {emailError   && <p className="text-sm text-red-600">{emailError}</p>}
              {emailSuccess && <p className="text-sm text-green-700">Email updated — check your inbox to verify it.</p>}
              <Button onClick={handleUpdateEmail} loading={emailLoading} variant="secondary" size="sm" className="self-start">
                Update email
              </Button>
            </div>
          </div>
        </div>

        {/* Change password */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="font-semibold text-gray-900 mb-4">Change password</h2>
          <div className="flex flex-col gap-3">
            <Input label="Current password" type="password" value={current}
              onChange={e => setCurrent(e.target.value)} autoComplete="current-password" />
            <Input label="New password" type="password" value={newPass}
              onChange={e => setNewPass(e.target.value)} autoComplete="new-password"
              placeholder="Min. 8 characters" />
            <Input label="Confirm new password" type="password" value={confirm}
              onChange={e => setConfirm(e.target.value)} autoComplete="new-password" />
            {pwError   && <p className="text-sm text-red-600">{pwError}</p>}
            {pwSuccess && <p className="text-sm text-green-700">Password updated. Other sessions signed out.</p>}
            <Button onClick={handleChangePassword} loading={pwLoading} variant="secondary" className="self-start">
              Update password
            </Button>
          </div>
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

      <Modal open={deleteOpen} onClose={() => setDeleteOpen(false)} title="Delete account">
        <p className="text-sm text-gray-600 mb-4">
          This will permanently delete your account. Enter your password to confirm.
        </p>
        <div className="flex flex-col gap-3">
          <Input type="password" placeholder="Your password" value={deletePass}
            onChange={e => setDeletePass(e.target.value)} />
          {deleteError && <p className="text-sm text-red-600">{deleteError}</p>}
          <div className="flex gap-3">
            <Button variant="secondary" onClick={() => setDeleteOpen(false)} className="flex-1">
              Cancel
            </Button>
            <Button variant="danger" onClick={handleDeleteAccount} loading={deleteLoading} className="flex-1">
              Delete permanently
            </Button>
          </div>
        </div>
      </Modal>
    </DashboardLayout>
  )
}
