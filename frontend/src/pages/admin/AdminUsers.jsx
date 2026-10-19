import { useState, useEffect, useCallback } from 'react'
import api, { getErrorMessage } from '../../lib/api'
import Button from '../../components/ui/Button'
import Input from '../../components/ui/Input'
import Select from '../../components/ui/Select'
import Checkbox from '../../components/ui/Checkbox'
import Badge from '../../components/ui/Badge'
import Spinner from '../../components/ui/Spinner'
import DataTable from '../../components/ui/DataTable'
import Pagination from '../../components/ui/Pagination'
import ConfirmDialog from '../../components/ui/ConfirmDialog'
import { useToast } from '../../components/ui/Toast'
import { formatDate } from '../../lib/utils'
import usePageClamp from '../../hooks/usePageClamp'
import EmptyState from '../../components/ui/EmptyState'
import useLatestRequest from '../../hooks/useLatestRequest'
import useDebouncedState from '../../hooks/useDebouncedState'

const PAGE_SIZE = 25

export default function AdminUsers() {
  const toast = useToast()
  const [users, setUsers] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [pendingAction, setPendingAction] = useState(null)
  const [bouncedOnly, setBouncedOnly] = useState(false)   // Webhooks round 14 (G1)

  // Section 11 (round 16): the box updates per keystroke but the request only follows once typing pauses. Before this each
  // character was a request against the 100 / 15 min general limiter. Page resets to 1 in the same tick as the new text.
  const searchBox = useDebouncedState('', 350, () => setPage(1))
  const search = searchBox.committed.trim()

  const begin = useLatestRequest()

  const load = useCallback(async () => {
    const isCurrent = begin()
    setLoading(true)
    try {
      const res = await api.get('/admin/users', {
        signal: isCurrent.signal,
        params: { page, pageSize: PAGE_SIZE, search: search || undefined, status: status || undefined, bounced: bouncedOnly ? '1' : undefined }
      })
      if (!isCurrent()) return
      setUsers(res.data.data)
      setTotal(res.data.meta.total)
    } catch (_) {
      if (!isCurrent()) return
      toast({ message: 'Failed to load users.', type: 'error' })
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [page, search, status, bouncedOnly])

  useEffect(() => { load() }, [load])

  // BUG FIX (audit, feature gap): was `if (confirmMsg && !window.confirm(confirmMsg)) return`
  // — see components/ui/ConfirmDialog.jsx. Actions with no confirmMsg (Reset
  // quota, Unban) still run immediately; ones that had a confirmMsg now open
  // the dialog instead, and the actual PATCH runs from confirmPendingAction.
  function updateUser(user, patch, confirmMsg, danger = true) {
    if (confirmMsg) { setPendingAction({ user, patch, confirmMsg, danger }); return }
    return runUpdateUser(user, patch)
  }

  async function runUpdateUser(user, patch) {
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

  async function confirmPendingAction() {
    const { user, patch } = pendingAction
    await runUpdateUser(user, patch)
    setPendingAction(null)
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))


  usePageClamp({ page, total, pageSize: PAGE_SIZE, setPage, loading })
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-gray-900">Users</h1>

      <div className="flex gap-3 flex-wrap items-end">
        <Input label="Search" placeholder="Email or name" value={searchBox.value}
          onChange={e => searchBox.setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') searchBox.commitNow() }} wrapperClassName="w-64" />
        <Select label="Status" value={status} onChange={e => { setPage(1); setStatus(e.target.value) }}>
          <option value="">All</option>
          <option value="ACTIVE">Active</option>
          <option value="BANNED">Banned</option>
        </Select>
        <Checkbox label="Email undeliverable" checked={bouncedOnly} wrapperClassName="pb-2"
          onChange={e => { setPage(1); setBouncedOnly(e.target.checked) }} />
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : users.length === 0 ? (
        <EmptyState>No users found.</EmptyState>
      ) : (
        <DataTable
          caption="Users"
          columns={[
            {
              key: 'user',
              header: 'User',
              cell: u => (
                <>
                  <div className="font-medium text-gray-900">{u.name}</div>
                  <div className="text-gray-400 text-xs">{u.email}</div>
                </>
              ),
            },
            {
              key: 'role',
              header: 'Role',
              cell: u => (
                <>
                  <Badge variant={u.role === 'ADMIN' ? 'blue' : 'gray'}>{u.role}</Badge>
                </>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              cell: u => (
                <>
                  <Badge variant={u.status === 'ACTIVE' ? 'green' : 'red'}>{u.status}</Badge>
                  {!u.emailVerified && <span className="text-xs text-gray-400 ml-1">(unverified)</span>}
                  {u.emailBounce && <Badge variant="amber">{u.emailBounce.type === 'complaint' ? 'spam complaint' : u.emailBounce.type === 'suppressed' ? 'email suppressed' : 'email bounces'}</Badge>}
                </>
              ),
            },
            {
              key: 'scansToday',
              header: 'Scans today',
              headerClassName: 'text-right',
              cellClassName: 'text-right text-gray-600',
              cell: u => u.scansToday,
            },
            {
              key: 'joined',
              header: 'Joined',
              cellClassName: 'text-gray-500',
              cell: u => formatDate(u.createdAt),
            },
            // FIX (Section 9/10 audit, feature gap): terms_accepted_at/terms_version (migration 0038) were captured at
            // signup but never shown anywhere — not here, not on the user's own account. This is the compliance-
            // facing read path: which version, and when. Pre-migration accounts show "—" (they signed up before the
            // checkbox existed, not an error).
            {
              key: 'terms',
              header: 'Terms',
              cellClassName: 'text-gray-500',
              cell: u => (
                <>
                  {u.termsAcceptedAt ? (
                    <span title={u.termsVersion ? `Version ${u.termsVersion}` : undefined}>
                      {formatDate(u.termsAcceptedAt)}
                      {u.termsVersion && <span className="text-xs text-gray-400 ml-1">({u.termsVersion})</span>}
                    </span>
                  ) : (
                    <span className="text-xs text-gray-400">—</span>
                  )}
                </>
              ),
            },
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              cell: u => (
                <>
                  <div className="flex gap-2 justify-end flex-wrap">
                    <Button size="sm" variant="secondary" disabled={busyId === u.id}
                      onClick={() => updateUser(u, { resetScansToday: true })}>
                      Reset quota
                    </Button>
                    {u.status === 'ACTIVE' ? (
                      <Button size="sm" variant="danger" disabled={busyId === u.id}
                        onClick={() => updateUser(u, { status: 'BANNED' }, `Ban ${u.email}?`, true)}>
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
                        onClick={() => updateUser(u, { role: 'SEEKER' }, `Remove admin access from ${u.email}?`, true)}>
                        Demote
                      </Button>
                    ) : (
                      <Button size="sm" variant="secondary" disabled={busyId === u.id}
                        onClick={() => updateUser(u, { role: 'ADMIN' }, `Make ${u.email} an admin?`, false)}>
                        Promote
                      </Button>
                    )}
                  </div>
                </>
              ),
            },
          ]}
          rows={users}
          rowKey={u => u.id}
        />
      )}

      {totalPages > 1 && (
        <Pagination page={page} totalPages={totalPages} onChange={p => setPage(p)} />
      )}

      <ConfirmDialog
        open={!!pendingAction}
        title="Confirm"
        message={pendingAction?.confirmMsg}
        danger={pendingAction?.danger ?? true}
        loading={busyId === pendingAction?.user.id}
        onConfirm={confirmPendingAction}
        onCancel={() => setPendingAction(null)}
      />
    </div>
  )
}
