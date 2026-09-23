import { useState, useEffect, useCallback } from 'react'
import api from '../../lib/api'
import Button from '../../components/ui/Button'
import Input from '../../components/ui/Input'
import Badge from '../../components/ui/Badge'
import Spinner from '../../components/ui/Spinner'
import ConfirmDialog from '../../components/ui/ConfirmDialog'
import Pagination from '../../components/ui/Pagination'
import { useToast } from '../../components/ui/Toast'
import { formatDate } from '../../lib/utils'

const STATUS_VARIANT = { NEW: 'blue', CONTACTED: 'amber', CONVERTED: 'green', ARCHIVED: 'gray' }
const STATUSES = ['NEW', 'CONTACTED', 'CONVERTED', 'ARCHIVED']
const PAGE_SIZE = 25

const formatRole = (cat) => cat ? cat.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : null

// Calls the existing GET /api/employer-leads (admin-gated) endpoint rather
// than a duplicate /api/admin/leads — that retrieval gap was already closed
// directly in employer-leads.controller.js.
//
// FEATURE GAP CLOSED (Section 5, second fixing-time pass): the previous pass
// left this unpaginated "on purpose, since low volume" — the volume argument
// doesn't hold once the homepage form (also added this pass) gives leads a
// second, higher-traffic entry point, and Supabase silently truncates an
// unpaginated list at its own row cap regardless. Adds real pagination
// (Pagination.jsx, same as every other admin list), status-count chips,
// candidate-supply-per-field context (so an admin can see whether a lead's
// field actually has verified candidates to offer), a CSV export of the
// current filter, and surfaces the role-title / submission-count /
// last-active columns the resubmission-safe controller rewrite now returns.
export default function AdminLeads() {
  const toast = useToast()
  const [leads, setLeads] = useState([])
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState({})
  const [candidateSupply, setCandidateSupply] = useState(null)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [sort, setSort] = useState('created')
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [exporting, setExporting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get('/employer-leads', {
        params: { page, pageSize: PAGE_SIZE, search: search || undefined, status: status || undefined, sort }
      })
      setLeads(res.data.data)
      setTotal(res.data.meta.total)
      setCounts(res.data.meta.counts || {})
      setCandidateSupply(res.data.meta.candidateSupply)
    } catch (_) {
      toast({ message: 'Failed to load leads.', type: 'error' })
    } finally {
      setLoading(false)
    }
  }, [page, search, status, sort])

  useEffect(() => { load() }, [load])

  function withFilter(setter) {
    return (value) => { setPage(1); setter(value) }
  }

  async function changeStatus(lead, newStatus) {
    setBusyId(lead.id)
    try {
      const res = await api.patch(`/employer-leads/${lead.id}`, { status: newStatus })
      setLeads(prev => prev.map(l => l.id === lead.id ? res.data.data : l))
    } catch (err) {
      toast({ message: err.response?.data?.message || 'Failed to update lead.', type: 'error' })
    } finally {
      setBusyId(null)
    }
  }

  // FEATURE GAP CLOSED (Section 5, fixing-time pass): status alone can't
  // record why a lead ended up there. Saves on blur rather than per-
  // keystroke, same reasoning as everywhere else in the admin panel that
  // edits free text next to a live list.
  async function saveNotes(lead, newNotes) {
    if ((lead.notes || '') === newNotes) return
    setBusyId(lead.id)
    try {
      const res = await api.patch(`/employer-leads/${lead.id}`, { notes: newNotes })
      setLeads(prev => prev.map(l => l.id === lead.id ? res.data.data : l))
    } catch (err) {
      toast({ message: err.response?.data?.message || 'Failed to save note.', type: 'error' })
    } finally {
      setBusyId(null)
    }
  }

  // BUG FIX (audit, feature gap): was `if (!window.confirm(...)) return` — see
  // components/ui/ConfirmDialog.jsx for why. removeLead now just opens the
  // dialog; the actual delete moved to confirmRemoveLead, run on confirm.
  function removeLead(lead) {
    setPendingDelete(lead)
  }

  async function confirmRemoveLead() {
    const lead = pendingDelete
    setBusyId(lead.id)
    try {
      await api.delete(`/employer-leads/${lead.id}`)
      setLeads(prev => prev.filter(l => l.id !== lead.id))
      setTotal(t => Math.max(0, t - 1))
      toast({ message: 'Lead deleted.', type: 'success' })
      setPendingDelete(null)
    } catch (err) {
      toast({ message: err.response?.data?.message || 'Failed to delete lead.', type: 'error' })
      setPendingDelete(null)
    } finally {
      setBusyId(null)
    }
  }

  async function exportCsv() {
    setExporting(true)
    try {
      const res = await api.get('/employer-leads/export.csv', {
        params: { search: search || undefined, status: status || undefined, sort },
        responseType: 'blob'
      })
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url; a.download = 'employer-leads.csv'
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      toast({ message: err.response?.data?.message || 'Export failed.', type: 'error' })
    } finally {
      setExporting(false)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-gray-900">Employer Leads</h1>
        <Button size="sm" variant="secondary" loading={exporting} onClick={exportCsv}>
          Export CSV
        </Button>
      </div>

      <div className="flex gap-2 flex-wrap">
        <button onClick={withFilter(setStatus)('')}
          className={`text-xs px-3 py-1.5 rounded-full border ${!status ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-300 text-gray-600'}`}>
          All ({total})
        </button>
        {STATUSES.map(s => (
          <button key={s} onClick={() => withFilter(setStatus)(s)}
            className={`text-xs px-3 py-1.5 rounded-full border ${status === s ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-300 text-gray-600'}`}>
            {s} ({counts[s] ?? 0})
          </button>
        ))}
      </div>

      <div className="flex gap-3 flex-wrap items-end">
        <Input label="Search" placeholder="Name, company, email, or role" value={search}
          onChange={e => withFilter(setSearch)(e.target.value)} className="w-64" />
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-gray-700">Sort</label>
          <select value={sort} onChange={e => setSort(e.target.value)}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm">
            <option value="created">Newest first</option>
            <option value="activity">Most recently active</option>
          </select>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : leads.length === 0 ? (
        <p className="text-sm text-gray-500">No leads found.</p>
      ) : (
        <div className="border border-gray-200 rounded-lg bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Company</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Field</th>
                <th className="px-4 py-3">Role title</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3">Received</th>
                <th className="px-4 py-3">Last active</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Notes</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {leads.map(l => (
                <tr key={l.id}>
                  <td className="px-4 py-3 font-medium text-gray-900">{l.name}</td>
                  <td className="px-4 py-3 text-gray-600">{l.company}</td>
                  <td className="px-4 py-3 text-gray-600">
                    <a href={`mailto:${l.email}`} className="text-blue-600 hover:underline">{l.email}</a>
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {l.roleCategory ? (
                      <>
                        {formatRole(l.roleCategory)}
                        {candidateSupply && (
                          <span className={`ml-1 text-xs ${candidateSupply[l.roleCategory] ? 'text-green-600' : 'text-gray-400'}`}>
                            ({candidateSupply[l.roleCategory] || 0} verified)
                          </span>
                        )}
                      </>
                    ) : '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-500">{l.roleTitle || '—'}</td>
                  <td className="px-4 py-3 text-gray-500">
                    {l.source}
                    {/* SECTION 7 AUDIT (feature gap): which candidate's verification
                        page this lead came from, when it came from one. */}
                    {l.sourceCode && (
                      <a href={`/v/${l.sourceCode}`} target="_blank" rel="noreferrer"
                        className="block text-xs text-blue-700 hover:text-blue-800 underline">
                        {l.sourceCode}
                      </a>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {formatDate(l.createdAt)}
                    {l.submissionCount > 1 && (
                      <span className="block text-xs text-amber-600">resubmitted ×{l.submissionCount}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-500">{formatDate(l.lastSubmittedAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Badge variant={STATUS_VARIANT[l.status] || 'gray'}>{l.status}</Badge>
                      <select
                        value={l.status}
                        disabled={busyId === l.id}
                        onChange={e => changeStatus(l, e.target.value)}
                        className="rounded-md border border-gray-300 px-2 py-1 text-xs"
                      >
                        {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    {l.contactedAt && (
                      <div className="text-xs text-gray-400 mt-1">Contacted {formatDate(l.contactedAt)}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <textarea
                      key={`${l.id}:${l.notes || ''}`}
                      defaultValue={l.notes || ''}
                      disabled={busyId === l.id}
                      onBlur={e => saveNotes(l, e.target.value.trim())}
                      placeholder="Add a note…"
                      rows={1}
                      className="w-40 rounded-md border border-gray-300 px-2 py-1 text-xs resize-y"
                    />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button size="sm" variant="danger" disabled={busyId === l.id} onClick={() => removeLead(l)}>
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination page={page} totalPages={totalPages} onChange={setPage} />

      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete lead"
        message={pendingDelete ? `Delete the lead from ${pendingDelete.email}? This can't be undone.` : ''}
        confirmLabel="Delete"
        loading={busyId === pendingDelete?.id}
        onConfirm={confirmRemoveLead}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  )
}
