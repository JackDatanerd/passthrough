import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../../lib/api'
import { useAuth } from '../../hooks/useAuth'
import DashboardLayout from '../../components/layout/DashboardLayout'
import Button from '../../components/ui/Button'
import Input from '../../components/ui/Input'
import Modal from '../../components/ui/Modal'

export default function Settings() {
  const navigate      = useNavigate()
  const { user, logout } = useAuth()

  // Change password
  const [current,  setCurrent ] = useState('')
  const [newPass,  setNewPass ] = useState('')
  const [confirm,  setConfirm ] = useState('')
  const [pwLoading, setPwLoading] = useState(false)
  const [pwError,   setPwError  ] = useState('')
  const [pwSuccess, setPwSuccess] = useState(false)

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
      await api.patch('/auth/password', { currentPassword: current, newPassword: newPass })
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
          <div className="flex flex-col gap-1 text-sm">
            <p className="text-gray-600"><span className="font-medium">Name:</span> {user?.name}</p>
            <p className="text-gray-600"><span className="font-medium">Email:</span> {user?.email}</p>
            <p className="text-gray-600">
              <span className="font-medium">Email verified:</span>{' '}
              {user?.emailVerified
                ? <span className="text-green-700">Yes</span>
                : <span className="text-amber-600">No — check your inbox</span>
              }
            </p>
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
