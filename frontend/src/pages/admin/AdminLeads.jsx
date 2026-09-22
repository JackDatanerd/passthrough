import { useState, useEffect, useCallback } from 'react'
import api from '../../lib/api'
import Button from '../../components/ui/Button'
import Input from '../../components/ui/Input'
import Badge from '../../components/ui/Badge'
import Spinner from '../../components/ui/Spinner'
import ConfirmDialog from '../../components/ui/ConfirmDialog'
import { useToast } from '../../components/ui/Toast'
import { formatDate } from '../../lib/utils'

const STATUS_VARIANT = { NEW: 'blue', CONTACTED: 'amber', CONVERTED: 'green', ARCHIVED: 'gray' }
const STATUSES = ['NEW', 'CONTACTED', 'CONVERTED', 'ARCHIVED']

// Calls the existing GET /api/employer-leads (admin-gated) endpoint rather
// than a duplicate /api/admin/leads — that retrieval gap was already closed
// directly in employer-leads.controller.js.
//
// FEATURE GAP CLOSED (Section 5, fixing-time pass): this was purely
// read-only — no lifecycle tracking, no search/filter, no way to clear
// spam. Follows the same load/busyId/confirm pattern as AdminUsers.jsx.
// Still unpaginated on purpose, same reasoning as before (low volume;
// search/status narrow the list well enough for now).
export default function AdminLeads() {
  const toast = useToast()
  const [leads, setLeads] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get('/employer-leads', {
        params: { search: search || undefined, status: status || undefined }
      })
      setLeads(res.data.data)
    } catch (_) {
      toast({ message: 'Failed to load leads.', type: 'error' })
    } finally {
      setLoading(false)
    }
  }, [search, status])

  useEffect(() => { load() }, [load])

  async function changeStatus(lead, newStatus) {
    setBusyId(lead.id)
    try {
      await api.patch(`/employer-leads/${lead.id}`, { status: newStatus })
      setLeads(prev => prev.map(l => l.id === lead.id ? { ...l, status: newStatus } : l))
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
      await api.patch(`/employer-leads/${lead.id}`, { notes: newNotes })
      setLeads(prev => prev.map(l => l.id === lead.id ? { ...l, notes: newNotes } : l))
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
      toast({ message: 'Lead deleted.', type: 'success' })
      setPendingDelete(null)
    } catch (err) {
      toast({ message: err.response?.data?.message || 'Failed to delete lead.', type: 'error' })
      setPendingDelete(null)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-gray-900">Employer Leads</h1>

      <div className="flex gap-3 flex-wrap items-end">
        <Input label="Search" placeholder="Name, company, or email" value={search}
          onChange={e => setSearch(e.target.value)} className="w-64" />
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-gray-700">Status</label>
          <select value={status} onChange={e => setStatus(e.target.value)}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm">
            <option value="">All</option>
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
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
                <th className="px-4 py-3">Role category</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3">Received</th>
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
                  <td className="px-4 py-3 text-gray-500">{l.roleCategory || '—'}</td>
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
                  <td className="px-4 py-3 text-gray-500">{formatDate(l.createdAt)}</td>
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
