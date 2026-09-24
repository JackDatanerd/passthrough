import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import api, { getErrorMessage } from '../../lib/api'
import Button from '../../components/ui/Button'
import Input from '../../components/ui/Input'
import Badge from '../../components/ui/Badge'
import Spinner from '../../components/ui/Spinner'
import Form from '../../components/ui/Form'
import Modal from '../../components/ui/Modal'
import ConfirmDialog from '../../components/ui/ConfirmDialog'
import Pagination from '../../components/ui/Pagination'
import { useToast } from '../../components/ui/Toast'
import { formatDate } from '../../lib/utils'
import { ROLE_CATEGORIES, roleLabel } from '../../lib/roleCategories'

const STATUS_VARIANT = { NEW: 'blue', CONTACTED: 'amber', CONVERTED: 'green', ARCHIVED: 'gray' }
const STATUSES = ['NEW', 'CONTACTED', 'CONVERTED', 'ARCHIVED']
const PAGE_SIZE = 25
const SEARCH_DEBOUNCE_MS = 350

const selectClass = 'rounded-md border border-gray-300 px-3 py-2 text-sm bg-white'

// Filters, sort and page live in the URL (like Payments and Scans), so the
// dashboard's "N new leads" link can open the list already filtered, a
// refresh keeps your place, and a filtered view can be shared.
export default function AdminLeads() {
  const toast = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  const page   = Math.max(parseInt(searchParams.get('page'), 10) || 1, 1)
  const status = STATUSES.includes(searchParams.get('status')) ? searchParams.get('status') : ''
  const field  = searchParams.get('field') || ''
  const search = searchParams.get('search') || ''
  const sort   = searchParams.get('sort') === 'activity' ? 'activity' : 'created'

  const [leads, setLeads] = useState([])
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState({})
  const [candidateSupply, setCandidateSupply] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [exporting, setExporting] = useState(false)
  const [selected, setSelected] = useState(() => new Set())
  const [bulkStatus, setBulkStatus] = useState('CONTACTED')
  const [bulkBusy, setBulkBusy] = useState(false)
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const [editing, setEditing] = useState(null)     // lead being edited
  const [adding, setAdding] = useState(false)

  // Any change of filter/sort goes through here so the page resets to 1 —
  // unless the change IS the page.
  function setParams(updates) {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      for (const [k, v] of Object.entries(updates)) {
        if (v === '' || v == null || (k === 'page' && Number(v) <= 1) || (k === 'sort' && v === 'created')) next.delete(k)
        else next.set(k, String(v))
      }
      if (!('page' in updates)) next.delete('page')
      return next
    })
  }

  // Search box: local text, committed to the URL after a pause — a request per
  // keystroke cost six database queries each and let a slow early response
  // overwrite a fast later one. committedRef is what stops the URL -> input
  // sync below from overwriting characters typed after a commit.
  const [searchInput, setSearchInput] = useState(search)
  const committedRef = useRef(search)
  useEffect(() => {
    if (search !== committedRef.current) { committedRef.current = search; setSearchInput(search) }
  }, [search])
  useEffect(() => {
    if (searchInput === committedRef.current) return
    const handle = setTimeout(() => { committedRef.current = searchInput; setParams({ search: searchInput.trim() }) }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput])

  // Only the newest request may write state.
  const requestId = useRef(0)
  const load = useCallback(async ({ silent = false } = {}) => {
    const id = ++requestId.current
    if (!silent) setLoading(true)
    try {
      const res = await api.get('/employer-leads', {
        params: { page, pageSize: PAGE_SIZE, search: search || undefined, status: status || undefined, field: field || undefined, sort }
      })
      if (id !== requestId.current) return
      const meta = res.data.meta
      // Rows were removed since this page was last loaded (or the URL is stale):
      // step back to the last page that exists rather than showing "no leads".
      const lastPage = Math.max(1, Math.ceil(meta.total / PAGE_SIZE))
      if (page > lastPage) { setParams({ page: lastPage }); return }
      setLeads(res.data.data)
      setTotal(meta.total)
      setCounts(meta.counts || {})
      setCandidateSupply(meta.candidateSupply)
      setSelected(new Set())
    } catch (err) {
      if (id === requestId.current) toast({ message: getErrorMessage(err, 'Failed to load leads.'), type: 'error' })
    } finally {
      if (id === requestId.current) setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, search, status, field, sort])

  useEffect(() => { load() }, [load])
  const refresh = () => load({ silent: true })

  async function changeStatus(lead, newStatus) {
    setBusyId(lead.id)
    try {
      await api.patch(`/employer-leads/${lead.id}`, { status: newStatus })
      await refresh()   // counts, filtered membership and the contacted date all change
    } catch (err) {
      toast({ message: getErrorMessage(err, 'Failed to update lead.'), type: 'error' })
    } finally {
      setBusyId(null)
    }
  }

  // Saves on blur rather than per-keystroke.
  async function saveNotes(lead, newNotes) {
    if ((lead.notes || '') === newNotes) return
    setBusyId(lead.id)
    try {
      const res = await api.patch(`/employer-leads/${lead.id}`, { notes: newNotes })
      setLeads(prev => prev.map(l => l.id === lead.id ? res.data.data : l))
    } catch (err) {
      toast({ message: getErrorMessage(err, 'Failed to save note.'), type: 'error' })
    } finally {
      setBusyId(null)
    }
  }

  async function confirmRemoveLead() {
    const lead = pendingDelete
    setBusyId(lead.id)
    try {
      await api.delete(`/employer-leads/${lead.id}`)
      toast({ message: 'Lead deleted.', type: 'success' })
      setPendingDelete(null)
      await refresh()
    } catch (err) {
      toast({ message: getErrorMessage(err, 'Failed to delete lead.'), type: 'error' })
      setPendingDelete(null)
    } finally {
      setBusyId(null)
    }
  }

  async function runBulk(body, doneMessage) {
    setBulkBusy(true)
    try {
      const res = await api.post('/employer-leads/bulk', { ids: [...selected], ...body })
      toast({ message: `${doneMessage} (${res.data.affected}).`, type: 'success' })
      setConfirmBulkDelete(false)
      await refresh()
    } catch (err) {
      toast({ message: getErrorMessage(err, 'Bulk action failed.'), type: 'error' })
      setConfirmBulkDelete(false)
    } finally {
      setBulkBusy(false)
    }
  }

  async function exportCsv() {
    setExporting(true)
    try {
      const res = await api.get('/employer-leads/export.csv', {
        params: { search: search || undefined, status: status || undefined, field: field || undefined, sort },
        responseType: 'blob'
      })
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url; a.download = 'employer-leads.csv'
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      toast({ message: getErrorMessage(err, 'Export failed.'), type: 'error' })
    } finally {
      setExporting(false)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const allCount = STATUSES.reduce((sum, s) => sum + (counts[s] || 0), 0)
  const allSelected = leads.length > 0 && leads.every(l => selected.has(l.id))
  function toggleAll() { setSelected(allSelected ? new Set() : new Set(leads.map(l => l.id))) }
  function toggleOne(id) {
    setSelected(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next })
  }
  const chip = (active) =>
    `text-xs px-3 py-1.5 rounded-full border ${active ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-300 text-gray-600'}`

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-gray-900">Employer Leads</h1>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>Add lead</Button>
          <Button size="sm" variant="secondary" loading={exporting} onClick={exportCsv}>Export CSV</Button>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        <button onClick={() => setParams({ status: '' })} className={chip(!status)}>All ({allCount})</button>
        {STATUSES.map(s => (
          <button key={s} onClick={() => setParams({ status: s })} className={chip(status === s)}>
            {s} ({counts[s] ?? 0})
          </button>
        ))}
      </div>

      <div className="flex gap-3 flex-wrap items-end">
        <Input label="Search" placeholder="Name, company, email, or role" value={searchInput}
          onChange={e => setSearchInput(e.target.value)} className="w-64" />
        <div className="flex flex-col gap-1">
          <label htmlFor="lead-field" className="text-sm font-medium text-gray-700">Field</label>
          <select id="lead-field" value={field} onChange={e => setParams({ field: e.target.value })} className={selectClass}>
            <option value="">All fields</option>
            <option value="none">Uncategorised</option>
            {ROLE_CATEGORIES.map(([key, label]) => (
              <option key={key} value={key}>
                {label}{candidateSupply ? ` — ${candidateSupply[key] || 0} verified` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="lead-sort" className="text-sm font-medium text-gray-700">Sort</label>
          <select id="lead-sort" value={sort} onChange={e => setParams({ sort: e.target.value })} className={selectClass}>
            <option value="created">Newest first</option>
            <option value="activity">Most recently active</option>
          </select>
        </div>
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm">
          <span className="font-medium text-blue-900">{selected.size} selected</span>
          <select aria-label="Set status for selected leads" value={bulkStatus} onChange={e => setBulkStatus(e.target.value)} className={selectClass}>
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <Button size="sm" variant="secondary" loading={bulkBusy}
            onClick={() => runBulk({ action: 'setStatus', status: bulkStatus }, 'Status updated')}>
            Set status
          </Button>
          <Button size="sm" variant="danger" disabled={bulkBusy} onClick={() => setConfirmBulkDelete(true)}>Delete</Button>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : leads.length === 0 ? (
        <p className="text-sm text-gray-500">No leads found.</p>
      ) : (
        <div className="border border-gray-200 rounded-lg bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200">
                <th className="px-4 py-3">
                  <input type="checkbox" aria-label="Select all leads on this page" checked={allSelected} onChange={toggleAll} />
                </th>
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
                  <td className="px-4 py-3">
                    <input type="checkbox" aria-label={`Select ${l.email}`} checked={selected.has(l.id)} onChange={() => toggleOne(l.id)} />
                  </td>
                  <td className="px-4 py-3 font-medium text-gray-900">{l.name}</td>
                  <td className="px-4 py-3 text-gray-600">{l.company}</td>
                  <td className="px-4 py-3 text-gray-600">
                    <a href={`mailto:${l.email}`} className="text-blue-600 hover:underline">{l.email}</a>
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {l.roleCategory ? (
                      <>
                        {roleLabel(l.roleCategory)}
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
                        aria-label={`Status for ${l.email}`}
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
                      aria-label={`Notes for ${l.email}`}
                      defaultValue={l.notes || ''}
                      disabled={busyId === l.id}
                      maxLength={2000}
                      onBlur={e => saveNotes(l, e.target.value.trim())}
                      placeholder="Add a note…"
                      rows={1}
                      className="w-40 rounded-md border border-gray-300 px-2 py-1 text-xs resize-y"
                    />
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <Button size="sm" variant="secondary" disabled={busyId === l.id} onClick={() => setEditing(l)} className="mr-2">
                      Edit
                    </Button>
                    <Button size="sm" variant="danger" disabled={busyId === l.id} onClick={() => setPendingDelete(l)}>
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination page={page} totalPages={totalPages} onChange={p => setParams({ page: p })} />

      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete lead"
        message={pendingDelete ? `Delete the lead from ${pendingDelete.email}? This can't be undone.` : ''}
        confirmLabel="Delete"
        loading={busyId === pendingDelete?.id}
        onConfirm={confirmRemoveLead}
        onCancel={() => setPendingDelete(null)}
      />
      <ConfirmDialog
        open={confirmBulkDelete}
        title="Delete selected leads"
        message={`Delete ${selected.size} lead${selected.size === 1 ? '' : 's'}? This can't be undone.`}
        confirmLabel="Delete"
        loading={bulkBusy}
        onConfirm={() => runBulk({ action: 'delete' }, 'Leads deleted')}
        onCancel={() => setConfirmBulkDelete(false)}
      />

      <LeadFormModal
        open={adding} mode="add" onClose={() => setAdding(false)}
        onSaved={() => { setAdding(false); toast({ message: 'Lead added.', type: 'success' }); refresh() }}
      />
      <LeadFormModal
        open={!!editing} mode="edit" lead={editing} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); toast({ message: 'Lead updated.', type: 'success' }); refresh() }}
      />
    </div>
  )
}

// Add (POST /employer-leads/manual) and edit (PATCH /employer-leads/:id) share
// one form. The email is fixed once a lead exists: it is the identity the
// dedupe keys on.
function LeadFormModal({ open, mode, lead, onClose, onSaved }) {
  const [form, setForm] = useState({ name: '', company: '', email: '', roleCategory: '', roleTitle: '', notes: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setError('')
    setForm(mode === 'edit' && lead
      ? { name: lead.name, company: lead.company, email: lead.email, roleCategory: lead.roleCategory || '', roleTitle: lead.roleTitle || '', notes: '' }
      : { name: '', company: '', email: '', roleCategory: '', roleTitle: '', notes: '' })
  }, [open, mode, lead])

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  async function submit() {
    if (!form.name.trim() || !form.company.trim() || (mode === 'add' && !form.email.trim()))
      return setError(mode === 'add' ? 'Name, company and email are required.' : 'Name and company are required.')
    setSaving(true); setError('')
    try {
      if (mode === 'add') {
        await api.post('/employer-leads/manual', {
          name: form.name, company: form.company, email: form.email,
          roleCategory: form.roleCategory || null, roleTitle: form.roleTitle || null, notes: form.notes || null
        })
      } else {
        await api.patch(`/employer-leads/${lead.id}`, {
          name: form.name, company: form.company,
          roleCategory: form.roleCategory || null, roleTitle: form.roleTitle || null
        })
      }
      onSaved()
    } catch (err) {
      setError(getErrorMessage(err, 'Could not save the lead.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={mode === 'add' ? 'Add lead' : 'Edit lead'} dismissible={!saving}>
      <Form onSubmit={submit} className="flex flex-col gap-3">
        <Input label="Name" value={form.name} onChange={set('name')} />
        <Input label="Company" value={form.company} onChange={set('company')} />
        {mode === 'add'
          ? <Input label="Email" type="email" value={form.email} onChange={set('email')} />
          : <p className="text-sm text-gray-500">Email: {form.email}</p>}
        <div className="flex flex-col gap-1">
          <label htmlFor="lead-form-field" className="text-sm font-medium text-gray-700">Field</label>
          <select id="lead-form-field" value={form.roleCategory} onChange={set('roleCategory')} className={selectClass}>
            <option value="">Uncategorised</option>
            {ROLE_CATEGORIES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </div>
        <Input label="Role title (optional)" value={form.roleTitle} onChange={set('roleTitle')} />
        {mode === 'add' && (
          <div className="flex flex-col gap-1">
            <label htmlFor="lead-form-notes" className="text-sm font-medium text-gray-700">Notes (optional)</label>
            <textarea id="lead-form-notes" value={form.notes} onChange={set('notes')} rows={3} maxLength={2000}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm" />
          </div>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" loading={saving}>{mode === 'add' ? 'Add lead' : 'Save'}</Button>
        </div>
      </Form>
    </Modal>
  )
}
