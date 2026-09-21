import { useState, useEffect, useCallback } from 'react'
import api, { getErrorMessage } from '../../lib/api'
import Button from '../../components/ui/Button'
import Input from '../../components/ui/Input'
import Badge from '../../components/ui/Badge'
import Spinner from '../../components/ui/Spinner'
import { useToast } from '../../components/ui/Toast'
import { formatDate } from '../../lib/utils'

const PAGE_SIZE = 25

export default function AdminUsers() {
  const toast = useToast()
  const [users, setUsers] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get('/admin/users', {
        params: { page, pageSize: PAGE_SIZE, search: search || undefined, status: status || undefined }
      })
      setUsers(res.data.data)
      setTotal(res.data.meta.total)
    } catch (_) {
      toast({ message: 'Failed to load users.', type: 'error' })
    } finally {
      setLoading(false)
    }
  }, [page, search, status])

  useEffect(() => { load() }, [load])

  async function updateUser(user, patch, confirmMsg) {
    if (confirmMsg && !window.confirm(confirmMsg)) return
    setBusyId(user.id)
    try {
      await api.patch(`/admin/users/${user.id}`, patch)
      toast({ message: 'User updated.', type: 'success' })
      load()
    } catch (err) {
      toast({ message: getErrorMessage(err, 'Failed to update user.'), type: 'error' })
    } finally {
      setBusyId(null)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-gray-900">Users</h1>

      <div className="flex gap-3 flex-wrap items-end">
        <Input label="Search" placeholder="Email or name" value={search}
          onChange={e => { setPage(1); setSearch(e.target.value) }} className="w-64" />
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-gray-700">Status</label>
          <select value={status} onChange={e => { setPage(1); setStatus(e.target.value) }}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm">
            <option value="">All</option>
            <option value="ACTIVE">Active</option>
            <option value="BANNED">Banned</option>
          </select>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : users.length === 0 ? (
        <p className="text-sm text-gray-500">No users found.</p>
      ) : (
        <div className="border border-gray-200 rounded-lg bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200">
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Scans today</th>
                <th className="px-4 py-3">Joined</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.map(u => (
                <tr key={u.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{u.name}</div>
                    <div className="text-gray-400 text-xs">{u.email}</div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={u.role === 'ADMIN' ? 'blue' : 'gray'}>{u.role}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={u.status === 'ACTIVE' ? 'green' : 'red'}>{u.status}</Badge>
                    {!u.emailVerified && <span className="text-xs text-gray-400 ml-1">(unverified)</span>}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">{u.scansToday}</td>
                  <td className="px-4 py-3 text-gray-500">{formatDate(u.createdAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2 justify-end flex-wrap">
                      <Button size="sm" variant="secondary" disabled={busyId === u.id}
                        onClick={() => updateUser(u, { resetScansToday: true })}>
                        Reset quota
                      </Button>
                      {u.status === 'ACTIVE' ? (
                        <Button size="sm" variant="danger" disabled={busyId === u.id}
                          onClick={() => updateUser(u, { status: 'BANNED' }, `Ban ${u.email}?`)}>
                          Ban
                        </Button>
                      ) : (
                        <Button size="sm" variant="secondary" disabled={busyId === u.id}
                          onClick={() => updateUser(u, { status: 'ACTIVE' })}>
                          Unban
                        </Button>
                      )}
                      {u.role === 'ADMIN' ? (
                        <Button size="sm" variant="secondary" disabled={busyId === u.id}
                          onClick={() => updateUser(u, { role: 'SEEKER' }, `Remove admin access from ${u.email}?`)}>
                          Demote
                        </Button>
                      ) : (
                        <Button size="sm" variant="secondary" disabled={busyId === u.id}
                          onClick={() => updateUser(u, { role: 'ADMIN' }, `Make ${u.email} an admin?`)}>
                          Promote
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</Button>
          <span className="text-sm text-gray-500">Page {page} of {totalPages}</span>
          <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
        </div>
      )}
    </div>
  )
}
