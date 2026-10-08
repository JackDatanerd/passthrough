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
import Textarea from '../../components/ui/Textarea'
import Select from '../../components/ui/Select'
import { useToast } from '../../components/ui/Toast'
import { formatDate } from '../../lib/utils'
import { ROLE_CATEGORIES, roleLabel, isRoleCategory } from '../../lib/roleCategories'
import EmptyState from '../../components/ui/EmptyState'
import Checkbox from '../../components/ui/Checkbox'
import { leadRowsFromCsv, chunk } from '../../lib/leadImport'

const STATUS_VARIANT = { NEW: 'blue', CONTACTED: 'amber', CONVERTED: 'green', ARCHIVED: 'gray' }
const STATUSES = ['NEW', 'CONTACTED', 'CONVERTED', 'ARCHIVED']
const PAGE_SIZE = 25
// The server's per-call limit for mailing confirmation links (BULK_MAIL_MAX in the controller).
const BULK_MAIL_MAX = 25
const SEARCH_DEBOUNCE_MS = 350
// FEATURE GAP CLOSED (fresh audit pass, Section 5, traced from the
// controller/routes): source/sourceCounts and the suppression endpoints were
// all built and tested server-side (employer-leads.controller.js) but had no
// way to actually reach an admin — no source filter here, meta.sourceCounts
// and meta.suppressed were fetched into state nowhere, and nothing in the
// frontend called /suppressions/check or /suppressions at all. Mirrors
// ALL_LEAD_SOURCES there ('manual' is adminCreateLead's own source value, not
// something a stranger could submit, but an admin browsing/filtering needs
// to see it same as any other source that actually exists in the table).
const SOURCES = ['verification_page', 'homepage', 'manual']
const sourceLabel = (s) => ({ verification_page: 'Verification page', homepage: 'Homepage', manual: 'Manual' })[s] || s

// Filters, sort and page live in the URL (like Payments and Scans), so the
// dashboard's "N new leads" link can open the list already filtered, a
// refresh keeps your place, and a filtered view can be shared.
export default function AdminLeads() {
  const toast = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  const page   = Math.max(parseInt(searchParams.get('page'), 10) || 1, 1)
  // OPEN = NEW or CONTACTED (not a stored status): the filter the owner digest's link uses,
  // so the list it opens is the same size as the number in the email.
  const status = STATUSES.includes(searchParams.get('status')) || searchParams.get('status') === 'OPEN' ? searchParams.get('status') : ''
  const field  = searchParams.get('field') || ''
  const search = searchParams.get('search') || ''
  const sort   = searchParams.get('sort') === 'activity' ? 'activity' : 'created'
  // Whether the lead's email address was confirmed from the acknowledgement
  // mail: '' = all, 'yes', 'no'.
  const confirmed = ['yes', 'no'].includes(searchParams.get('confirmed')) ? searchParams.get('confirmed') : ''
  const source = SOURCES.includes(searchParams.get('source')) ? searchParams.get('source') : ''
  // Two "needs a look" views: unconfirmed leads we have never managed to email, and archived leads that
  // submitted the form again (they stay archived until you decide).
  const ack = searchParams.get('ack') === 'never' ? 'never' : ''
  const reengaged = searchParams.get('reengaged') === 'yes' ? 'yes' : ''

  const [leads, setLeads] = useState([])
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState({})
  const [unconfirmed, setUnconfirmed] = useState(0)
  const [neverEmailed, setNeverEmailed] = useState(0)
  const [reengagedCount, setReengagedCount] = useState(0)
  const [importing, setImporting] = useState(false)
  const [candidateSupply, setCandidateSupply] = useState(null)
  const [sourceCounts, setSourceCounts] = useState({})
  const [suppressed, setSuppressed] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [exporting, setExporting] = useState(false)
  const [selected, setSelected] = useState(() => new Set())
  const [bulkStatus, setBulkStatus] = useState('CONTACTED')
  const [bulkBusy, setBulkBusy] = useState(false)
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  // Independent audit round 8 (Section 5): "also add the address(es) to the do-not-contact list" on
  // delete (single and bulk) — a plain delete leaves nothing behind, so a spam address could resubmit
  // at once. Unticked by default: blocking is permanent for the public form.
  const [blockOnDelete, setBlockOnDelete] = useState(false)
  const [bulkField, setBulkField] = useState('')   // '' = clear the field (uncategorised)
  const [confirmBulkMarkConfirmed, setConfirmBulkMarkConfirmed] = useState(false)
  const [editing, setEditing] = useState(null)     // lead being edited
  const [adding, setAdding] = useState(false)
  // Independent audit round 6 (G1): "tell confirmed leads in this field there are Verified
  // candidates now" — a dry run first (how many would be emailed), then the real send.
  const [notifyPlan, setNotifyPlan] = useState(null)   // { field, candidates, eligible } while the confirm dialog is open
  const [notifyBusy, setNotifyBusy] = useState(false)

  // Do-not-contact lookup/lift modal (adminCheckSuppression / adminLiftSuppression).
  // Only a SHA-256 hash is stored server-side — there's no browsable list of
  // addresses, only a look-up-by-address and a lift-by-address, so that's
  // exactly what this modal offers, plus the total count already returned in
  // meta.suppressed above.
  const [pendingMarkConfirmed, setPendingMarkConfirmed] = useState(null)
  const [suppressionOpen, setSuppressionOpen] = useState(false)
  const [suppressionEmail, setSuppressionEmail] = useState('')
  const [suppressionChecking, setSuppressionChecking] = useState(false)
  const [suppressionLifting, setSuppressionLifting] = useState(false)
  // FEATURE GAP CLOSED (fresh audit pass, Section 5): adding, not just
  // checking/lifting. Before this, the only WRITE path to the do-not-contact
  // list was the public remove link in an acknowledgement email — someone who
  // asked to be removed by replying to that email, or by phone, had no
  // equivalent here. The only lever was deleting their lead outright, which
  // doesn't stop them resubmitting or being re-added later.
  const [suppressionAdding, setSuppressionAdding] = useState(false)
  const [suppressionResult, setSuppressionResult] = useState(null)   // { suppressed, since } for the last checked address
  const [suppressionError, setSuppressionError] = useState('')

  function closeSuppression() {
    setSuppressionOpen(false); setSuppressionEmail(''); setSuppressionResult(null); setSuppressionError('')
  }

  async function checkSuppression() {
    if (!suppressionEmail.trim()) return setSuppressionError('Enter an email address.')
    setSuppressionChecking(true); setSuppressionError(''); setSuppressionResult(null)
    try {
      const res = await api.post('/employer-leads/suppressions/check', { email: suppressionEmail.trim() })
      setSuppressionResult(res.data.data)
    } catch (err) {
      setSuppressionError(getErrorMessage(err, 'Could not check that address.'))
    } finally {
      setSuppressionChecking(false)
    }
  }

  async function addSuppression() {
    if (!suppressionEmail.trim()) return setSuppressionError('Enter an email address.')
    setSuppressionAdding(true); setSuppressionError('')
    try {
      const res = await api.post('/employer-leads/suppressions', { email: suppressionEmail.trim() })
      setSuppressionResult({ suppressed: true, since: new Date().toISOString(), leadExists: false })
      toast({
        message: res.data.data?.leadsRemoved ? 'Address suppressed and its lead removed.' : 'Address added to the do-not-contact list.',
        type: 'success'
      })
      await refresh()   // meta.suppressed count changes, and the lead (if any) disappears from the list
    } catch (err) {
      setSuppressionError(getErrorMessage(err, 'Could not add that suppression.'))
    } finally {
      setSuppressionAdding(false)
    }
  }

  async function liftSuppression() {
    setSuppressionLifting(true); setSuppressionError('')
    try {
      await api.delete('/employer-leads/suppressions', { data: { email: suppressionEmail.trim() } })
      setSuppressionResult({ suppressed: false, since: null })
      toast({ message: 'Suppression lifted.', type: 'success' })
      await refresh()   // meta.suppressed count changes
    } catch (err) {
      setSuppressionError(getErrorMessage(err, 'Could not lift that suppression.'))
    } finally {
      setSuppressionLifting(false)
    }
  }

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
        params: { page, pageSize: PAGE_SIZE, search: search || undefined, status: status || undefined, field: field || undefined, source: source || undefined, confirmed: confirmed || undefined, ack: ack || undefined, reengaged: reengaged || undefined, sort }
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
      setUnconfirmed(meta.unconfirmed ?? 0)
      setNeverEmailed(meta.neverEmailed ?? 0)
      setReengagedCount(meta.reengaged ?? 0)
      setCandidateSupply(meta.candidateSupply)
      setSourceCounts(meta.sourceCounts || {})
      setSuppressed(meta.suppressed)
      // BUG FIX (traced during Section 5's audit, out of that section's own
      // scope but closed here since it was already found): this used to
      // unconditionally wipe the whole bulk selection on every load,
      // including the silent background refresh a single-row action like
      // changeStatus or a single delete triggers — so ticking several leads
      // for a bulk action, then just nudging one row's own status dropdown,
      // silently emptied the selection with no explanation. Prune instead:
      // drop only the ids that are no longer in view (deleted, or filtered
      // out by a status/field change), and keep the rest selected.
      setSelected(prev => {
        if (prev.size === 0) return prev
        const ids = new Set(res.data.data.map(l => l.id))
        let changed = false
        const next = new Set()
        for (const id of prev) { if (ids.has(id)) next.add(id); else changed = true }
        return changed ? next : prev
      })
    } catch (err) {
      if (id === requestId.current) toast({ message: getErrorMessage(err, 'Failed to load leads.'), type: 'error' })
    } finally {
      if (id === requestId.current) setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, search, status, field, source, confirmed, ack, reengaged, sort])

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

  // Leads that arrived before address confirmation existed hold no confirm
  // link in any email; this sends them one.
  async function requestConfirmation(lead) {
    setBusyId(lead.id)
    try {
      await api.post(`/employer-leads/${lead.id}/request-confirmation`)
      toast({ message: `Confirmation email sent to ${lead.email}.`, type: 'success' })
    } catch (err) {
      toast({ message: getErrorMessage(err, 'Could not send the confirmation email.'), type: 'error' })
    } finally {
      setBusyId(null)
    }
  }

  // Records that the address was confirmed by some other route (a reply, a call). The
  // admin's word, not the inbox owner's click — hence the confirmation dialog and the audit entry.
  async function confirmMarkConfirmed() {
    const lead = pendingMarkConfirmed
    setBusyId(lead.id)
    try {
      await api.post(`/employer-leads/${lead.id}/mark-confirmed`)
      toast({ message: `${lead.email} marked as confirmed.`, type: 'success' })
      setPendingMarkConfirmed(null)
      await refresh()
    } catch (err) {
      toast({ message: getErrorMessage(err, 'Could not mark that lead as confirmed.'), type: 'error' })
      setPendingMarkConfirmed(null)
    } finally {
      setBusyId(null)
    }
  }

  async function confirmRemoveLead() {
    const lead = pendingDelete
    setBusyId(lead.id)
    try {
      if (blockOnDelete) await api.delete(`/employer-leads/${lead.id}`, { params: { suppress: true } })
      else await api.delete(`/employer-leads/${lead.id}`)
      toast({ message: blockOnDelete ? 'Lead deleted and its address blocked.' : 'Lead deleted.', type: 'success' })
      setPendingDelete(null)
      setBlockOnDelete(false)
      await refresh()
    } catch (err) {
      toast({ message: getErrorMessage(err, 'Failed to delete lead.'), type: 'error' })
      setPendingDelete(null)
      setBlockOnDelete(false)
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

  // Mails the confirm link to the selected unconfirmed leads (the server takes at most 25 at a time and
  // skips anyone already confirmed).
  async function runBulkRequestConfirmation() {
    setBulkBusy(true)
    try {
      const res = await api.post('/employer-leads/bulk', { ids: [...selected], action: 'requestConfirmation' })
      const { sent = 0, failed = 0, skipped = 0 } = res.data
      const parts = [`Confirmation sent to ${sent} lead${sent === 1 ? '' : 's'}`]
      if (failed) parts.push(`${failed} could not be sent (delivery failed or the address has reached its email limit)`)
      if (skipped) parts.push(`${skipped} skipped (already confirmed, or no longer there)`)
      toast({ message: parts.join('; ') + '.', type: failed ? 'warning' : 'success' })
      await refresh()
    } catch (err) {
      toast({ message: getErrorMessage(err, 'Bulk action failed.'), type: 'error' })
    } finally {
      setBulkBusy(false)
    }
  }

  async function startNotify() {
    setNotifyBusy(true)
    try {
      const res = await api.post('/employer-leads/notify-candidates', { field, dryRun: true })
      const d = res.data.data
      if (!d.eligible) toast({ message: `No confirmed, open ${roleLabel(field)} leads are waiting to be told (anyone told in the last 30 days is skipped).`, type: 'info' })
      else setNotifyPlan(d)
    } catch (err) {
      toast({ message: getErrorMessage(err, 'Could not check who would be notified.'), type: 'error' })
    } finally {
      setNotifyBusy(false)
    }
  }

  async function confirmNotify() {
    setNotifyBusy(true)
    try {
      const res = await api.post('/employer-leads/notify-candidates', { field: notifyPlan.field })
      const d = res.data.data
      const parts = [`Emailed ${d.sent} lead${d.sent === 1 ? '' : 's'}`]
      if (d.skipped) parts.push(`${d.skipped} skipped (already told recently, or on the do-not-contact list)`)
      if (d.failed) parts.push(`${d.failed} could not be sent — they will be tried again next time`)
      if (d.remaining) parts.push(`${d.remaining} still waiting — press the button again to continue`)
      toast({ message: parts.join('; ') + '.', type: d.failed ? 'warning' : 'success' })
      setNotifyPlan(null)
      await refresh()
    } catch (err) {
      toast({ message: getErrorMessage(err, 'Could not send the notifications.'), type: 'error' })
      setNotifyPlan(null)
    } finally {
      setNotifyBusy(false)
    }
  }

  async function exportCsv() {
    setExporting(true)
    try {
      const res = await api.get('/employer-leads/export.csv', {
        params: { search: search || undefined, status: status || undefined, field: field || undefined, source: source || undefined, confirmed: confirmed || undefined, ack: ack || undefined, reengaged: reengaged || undefined, sort },
        responseType: 'blob'
      })
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url; a.download = 'employer-leads.csv'
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
      // The server caps an export (50,000 rows) — say so instead of handing over a file that looks complete.
      if (res.headers?.['x-export-truncated'] === 'true')
        toast({ message: `The export hit its ${Number(res.headers['x-export-rows'] || 0).toLocaleString()}-row limit and is incomplete. Narrow the filters (status, field, source) and export again.`, type: 'warning', duration: 12000 })
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
          <Button size="sm" variant="secondary" onClick={() => { setSuppressionOpen(true) }}>
            Do-not-contact{suppressed != null ? ` (${suppressed})` : ''}
          </Button>
          {isRoleCategory(field) && (
            <Button size="sm" variant="secondary" loading={notifyBusy && !notifyPlan} onClick={startNotify}
              disabled={!!candidateSupply && !candidateSupply[field]}
              title={candidateSupply && !candidateSupply[field] ? 'There are no Verified candidates in this field yet.' : 'Email the confirmed, open leads in this field that there are now Verified candidates.'}>
              Notify {roleLabel(field)} leads
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>Add lead</Button>
          <Button size="sm" variant="secondary" onClick={() => setImporting(true)}>Import CSV</Button>
          <Button size="sm" variant="secondary" loading={exporting} onClick={exportCsv}>Export CSV</Button>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        <button onClick={() => setParams({ status: '' })} className={chip(!status)}>All ({allCount})</button>
        <button onClick={() => setParams({ status: 'OPEN' })} className={chip(status === 'OPEN')}>Open ({counts.OPEN ?? 0})</button>
        {STATUSES.map(s => (
          <button key={s} onClick={() => setParams({ status: s })} className={chip(status === s)}>
            {s} ({counts[s] ?? 0})
          </button>
        ))}
        {(neverEmailed > 0 || ack) && (
          <button onClick={() => setParams({ ack: ack ? '' : 'never' })} className={chip(!!ack)}
            title="Unconfirmed leads that have not been sent a confirmation email yet (the hourly retry keeps trying; you can also send one by hand).">
            Never emailed ({neverEmailed})
          </button>
        )}
        {(reengagedCount > 0 || reengaged) && (
          <button onClick={() => setParams({ reengaged: reengaged ? '' : 'yes' })} className={chip(!!reengaged)}
            title="Archived leads that submitted the form again. They stay archived until you change their status.">
            Came back while archived ({reengagedCount})
          </button>
        )}
      </div>

      <div className="flex gap-3 flex-wrap items-end">
        <Input label="Search" placeholder="Name, company, email, role, note, or page code" value={searchInput}
          onChange={e => setSearchInput(e.target.value)} wrapperClassName="w-64" />
        <Select id="lead-field" label="Field" value={field} onChange={e => setParams({ field: e.target.value })}>
          <option value="">All fields</option>
          <option value="none">Uncategorised</option>
          {ROLE_CATEGORIES.map(([key, label]) => (
            <option key={key} value={key}>
              {label}{candidateSupply ? ` — ${candidateSupply[key] || 0} verified` : ''}
            </option>
          ))}
        </Select>
        <Select id="lead-source" label="Source" value={source} onChange={e => setParams({ source: e.target.value })}>
          <option value="">All sources</option>
          {SOURCES.map(s => (
            <option key={s} value={s}>{sourceLabel(s)} ({sourceCounts[s] ?? 0})</option>
          ))}
        </Select>
        <Select id="lead-confirmed" label="Email" value={confirmed} onChange={e => setParams({ confirmed: e.target.value })}>
          <option value="">All addresses</option>
          <option value="yes">Confirmed</option>
          <option value="no">Unconfirmed ({unconfirmed})</option>
        </Select>
        <Select id="lead-sort" label="Sort" value={sort} onChange={e => setParams({ sort: e.target.value })}>
          <option value="created">Newest first</option>
          <option value="activity">Most recently active</option>
        </Select>
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm">
          <span className="font-medium text-blue-900">{selected.size} selected</span>
          <Select aria-label="Set status for selected leads" value={bulkStatus} onChange={e => setBulkStatus(e.target.value)} wrapperClassName="w-fit">
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </Select>
          <Button size="sm" variant="secondary" loading={bulkBusy}
            onClick={() => runBulk({ action: 'setStatus', status: bulkStatus }, 'Status updated')}>
            Set status
          </Button>
          <Select aria-label="Set field for selected leads" value={bulkField} onChange={e => setBulkField(e.target.value)} wrapperClassName="w-fit">
            <option value="">No field</option>
            {ROLE_CATEGORIES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </Select>
          <Button size="sm" variant="secondary" disabled={bulkBusy}
            onClick={() => runBulk({ action: 'setField', field: bulkField || null }, 'Field updated')}>
            Set field
          </Button>
          <Button size="sm" variant="secondary" disabled={bulkBusy} onClick={() => setConfirmBulkMarkConfirmed(true)}>Mark confirmed</Button>
          <Button size="sm" variant="secondary" disabled={bulkBusy || selected.size > BULK_MAIL_MAX}
            title={selected.size > BULK_MAIL_MAX ? `Select at most ${BULK_MAIL_MAX} leads to send confirmation emails` : undefined}
            onClick={runBulkRequestConfirmation}>
            Request confirmation
          </Button>
          <Button size="sm" variant="danger" disabled={bulkBusy} onClick={() => setConfirmBulkDelete(true)}>Delete</Button>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : leads.length === 0 ? (
        <EmptyState>No leads found.</EmptyState>
      ) : (
        <div className="border border-gray-200 rounded-lg bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200">
                <th className="px-4 py-3">
                  <Checkbox aria-label="Select all leads on this page" checked={allSelected} onChange={toggleAll} />
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
                    <Checkbox aria-label={`Select ${l.email}`} checked={selected.has(l.id)} onChange={() => toggleOne(l.id)} />
                  </td>
                  <td className="px-4 py-3 font-medium text-gray-900">{l.name}</td>
                  <td className="px-4 py-3 text-gray-600">{l.company}</td>
                  <td className="px-4 py-3 text-gray-600">
                    <a href={`mailto:${l.email}`} className="text-blue-600 hover:underline">{l.email}</a>
                    {l.confirmedAt
                      ? <span className="block text-xs text-green-600" title={`Confirmed ${formatDate(l.confirmedAt)}`}>✓ confirmed</span>
                      : <span className="block text-xs text-amber-600" title="This address has not been confirmed as belonging to the person who entered it — don't email it as a contact yet.">unconfirmed</span>}
                    {!l.confirmedAt && l.status !== 'ARCHIVED' && (l.lastAckAt
                      ? <span className="block text-xs text-gray-400">confirmation sent {formatDate(l.lastAckAt)}</span>
                      : <span className="block text-xs text-amber-600" title="No confirmation email has gone out to this address yet. It is retried hourly a few times; use Send confirm link to try now.">
                          no confirmation email sent{l.ackAttempts > 0 ? ` (${l.ackAttempts} ${l.ackAttempts === 1 ? 'retry' : 'retries'} failed)` : ''}
                        </span>)}
                    {l.lastCandidatesNotifiedAt && (
                      <span className="block text-xs text-gray-400" title="The last time Verified candidates were announced to this lead from here.">
                        told about candidates {formatDate(l.lastCandidatesNotifiedAt)}
                      </span>
                    )}
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
                    {l.extraRoleCategories?.length > 0 && (
                      <span className="block text-xs text-gray-400" title="Also hiring in these fields; candidate announcements reach them for each.">
                        also: {l.extraRoleCategories.map(roleLabel).join(', ')}
                      </span>
                    )}
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
                      <Select
                        aria-label={`Status for ${l.email}`}
                        value={l.status}
                        disabled={busyId === l.id}
                        onChange={e => changeStatus(l, e.target.value)}
                        size="sm"
                        wrapperClassName="w-fit"
                      >
                        {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                      </Select>
                    </div>
                    {l.contactedAt && (
                      <div className="text-xs text-gray-400 mt-1">Contacted {formatDate(l.contactedAt)}</div>
                    )}
                    {l.status === 'ARCHIVED' && l.archivedResubmittedAt && (
                      <div className="text-xs text-amber-600 mt-1" title="They submitted the form again after you archived them. Nothing was sent to them. Change the status to work this lead again, or archive it again to dismiss this.">
                        came back {formatDate(l.archivedResubmittedAt)}
                      </div>
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
                    {!l.confirmedAt && l.status !== 'ARCHIVED' && (
                      <Button size="sm" variant="secondary" disabled={busyId === l.id} onClick={() => requestConfirmation(l)} className="mr-2">
                        Send confirm link
                      </Button>
                    )}
                    {!l.confirmedAt && (
                      <Button size="sm" variant="secondary" disabled={busyId === l.id} onClick={() => setPendingMarkConfirmed(l)} className="mr-2">
                        Mark confirmed
                      </Button>
                    )}
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
        onCancel={() => { setPendingDelete(null); setBlockOnDelete(false) }}
      >
        <Checkbox label="Also block this address (do-not-contact): the form will ignore it from now on" checked={blockOnDelete}
          onChange={e => setBlockOnDelete(e.target.checked)} />
      </ConfirmDialog>
      <ConfirmDialog
        open={!!pendingMarkConfirmed}
        title="Mark as confirmed"
        message={pendingMarkConfirmed ? `Mark ${pendingMarkConfirmed.email} as confirmed? Only do this if they have confirmed the address is theirs another way (a reply or a call). It is recorded in the audit log.` : ''}
        confirmLabel="Mark confirmed"
        loading={busyId === pendingMarkConfirmed?.id}
        onConfirm={confirmMarkConfirmed}
        onCancel={() => setPendingMarkConfirmed(null)}
      />
      <ConfirmDialog
        open={!!notifyPlan}
        title="Notify leads"
        message={notifyPlan ? `Email ${Math.min(notifyPlan.eligible, 25)} of ${notifyPlan.eligible} confirmed lead${notifyPlan.eligible === 1 ? '' : 's'} in ${roleLabel(notifyPlan.field)} that there ${notifyPlan.candidates === 1 ? 'is 1 Verified candidate' : `are ${notifyPlan.candidates} Verified candidates`} now? Each gets one email with a remove link, and NEW leads move to CONTACTED. Nobody is emailed twice within 30 days.` : ''}
        confirmLabel="Send emails"
        loading={notifyBusy}
        onConfirm={confirmNotify}
        onCancel={() => setNotifyPlan(null)}
      />
      <ConfirmDialog
        open={confirmBulkDelete}
        title="Delete selected leads"
        message={`Delete ${selected.size} lead${selected.size === 1 ? '' : 's'}? This can't be undone.`}
        confirmLabel="Delete"
        loading={bulkBusy}
        onConfirm={async () => { await runBulk({ action: blockOnDelete ? 'deleteAndSuppress' : 'delete' }, blockOnDelete ? 'Leads deleted and blocked' : 'Leads deleted'); setBlockOnDelete(false) }}
        onCancel={() => { setConfirmBulkDelete(false); setBlockOnDelete(false) }}
      >
        <Checkbox label="Also block these addresses (do-not-contact): the form will ignore them from now on" checked={blockOnDelete}
          onChange={e => setBlockOnDelete(e.target.checked)} />
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmBulkMarkConfirmed}
        title="Mark selected as confirmed"
        message={`Mark ${selected.size} lead${selected.size === 1 ? '' : 's'} as confirmed? Only do this if you know the addresses are theirs (a reply, a call). Already-confirmed leads are left alone. It is recorded in the audit log.`}
        confirmLabel="Mark confirmed"
        danger={false}
        loading={bulkBusy}
        onConfirm={async () => { await runBulk({ action: 'markConfirmed' }, 'Marked as confirmed'); setConfirmBulkMarkConfirmed(false) }}
        onCancel={() => setConfirmBulkMarkConfirmed(false)}
      />

      <Modal open={suppressionOpen} onClose={closeSuppression} title="Do-not-contact list" dismissible={!suppressionChecking && !suppressionLifting && !suppressionAdding}>
        <p className="text-sm text-gray-500 mb-4">
          Only a hash of each address is stored, so there's no browsable list — look one up by address instead.
          Someone who asks to be removed some other way (a reply, a call) can be added here directly, without
          needing the link from their own acknowledgement email.
        </p>
        <Form onSubmit={checkSuppression} className="flex flex-col gap-3">
          <Input label="Email" type="email" value={suppressionEmail}
            onChange={e => { setSuppressionEmail(e.target.value); setSuppressionResult(null); setSuppressionError('') }} />
          {suppressionError && <p role="alert" className="text-sm text-red-600">{suppressionError}</p>}
          {suppressionResult && (
            suppressionResult.suppressed
              ? <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                  On the do-not-contact list since {formatDate(suppressionResult.since)}.
                </p>
              : <div className="flex flex-col gap-2">
                  <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-md px-3 py-2">
                    Not on the do-not-contact list.
                  </p>
                  {suppressionResult.leadExists && (
                    <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                      A lead exists for this address. Adding it to the list deletes that lead, including its notes.
                    </p>
                  )}
                </div>
          )}
          <div className="flex gap-3 justify-end">
            {suppressionResult?.suppressed && (
              <Button type="button" variant="danger" loading={suppressionLifting} onClick={liftSuppression}>
                Lift suppression
              </Button>
            )}
            {suppressionResult && !suppressionResult.suppressed && (
              <Button type="button" variant="danger" loading={suppressionAdding} onClick={addSuppression}>
                {suppressionResult.leadExists ? 'Add to list and delete its lead' : 'Add to do-not-contact list'}
              </Button>
            )}
            <Button type="submit" loading={suppressionChecking} variant="secondary">Check</Button>
          </div>
        </Form>
      </Modal>

      <LeadFormModal
        open={adding} mode="add" onClose={() => setAdding(false)}
        onSaved={() => { setAdding(false); toast({ message: 'Lead added.', type: 'success' }); refresh() }}
      />
      <LeadFormModal
        open={!!editing} mode="edit" lead={editing} onClose={() => setEditing(null)}
        onSaved={(res) => {
          setEditing(null)
          toast({ message: res?.confirmationReset ? 'Lead updated. The new address was sent a confirmation link.' : 'Lead updated.', type: 'success' })
          refresh()
        }}
      />
      <ImportLeadsModal
        open={importing} onClose={() => setImporting(false)}
        onDone={(created) => { setImporting(false); toast({ message: `${created} lead${created === 1 ? '' : 's'} imported.`, type: 'success' }); refresh() }}
      />
    </div>
  )
}

// Add (POST /employer-leads/manual) and edit (PATCH /employer-leads/:id) share
// one form. The email is fixed once a lead exists: it is the identity the
// dedupe keys on.
function LeadFormModal({ open, mode, lead, onClose, onSaved }) {
  const [form, setForm] = useState({ name: '', company: '', email: '', roleCategory: '', roleTitle: '', notes: '', extras: [] })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // The server refuses an address that used its "remove me" link (409,
  // code REMOVAL_REQUESTED) unless the admin confirms the person has since
  // asked to be added.
  const [needsOverride, setNeedsOverride] = useState(false)

  useEffect(() => {
    if (!open) return
    setError(''); setNeedsOverride(false)
    setForm(mode === 'edit' && lead
      ? { name: lead.name, company: lead.company, email: lead.email, roleCategory: lead.roleCategory || '', roleTitle: lead.roleTitle || '', notes: '', extras: lead.extraRoleCategories || [] }
      : { name: '', company: '', email: '', roleCategory: '', roleTitle: '', notes: '', extras: [] })
  }, [open, mode, lead])

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  async function submit({ override = false } = {}) {
    if (!form.name.trim() || !form.company.trim() || !form.email.trim())
      return setError('Name, company and email are required.')
    setSaving(true); setError('')
    try {
      if (mode === 'add') {
        await api.post('/employer-leads/manual', {
          name: form.name, company: form.company, email: form.email,
          roleCategory: form.roleCategory || null, roleTitle: form.roleTitle || null, notes: form.notes || null,
          ...(override ? { overrideRemoval: true } : {})
        })
      } else {
        const emailChanged = form.email.trim().toLowerCase() !== lead.email
        const res = await api.patch(`/employer-leads/${lead.id}`, {
          name: form.name, company: form.company,
          roleCategory: form.roleCategory || null, roleTitle: form.roleTitle || null,
          extraRoleCategories: form.roleCategory ? form.extras.filter(k => k !== form.roleCategory) : [],
          ...(emailChanged ? { email: form.email.trim() } : {})
        })
        return onSaved(res.data)
      }
      onSaved()
    } catch (err) {
      setNeedsOverride(err.response?.data?.code === 'REMOVAL_REQUESTED')
      setError(getErrorMessage(err, 'Could not save the lead.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={mode === 'add' ? 'Add lead' : 'Edit lead'} dismissible={!saving}>
      <Form onSubmit={() => submit()} className="flex flex-col gap-3">
        <Input label="Name" value={form.name} onChange={set('name')} />
        <Input label="Company" value={form.company} onChange={set('company')} />
        <Input label="Email" type="email" value={form.email} onChange={set('email')}
          hint={mode === 'edit' ? 'Changing the address resets its confirmation and sends a confirmation link to the new one.' : undefined} />
        <Select id="lead-form-field" label="Field" value={form.roleCategory} onChange={set('roleCategory')}>
          <option value="">Uncategorised</option>
          {ROLE_CATEGORIES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </Select>
        {mode === 'edit' && form.roleCategory && (
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm font-medium text-gray-700 mb-1">Also hiring in (up to 4)</legend>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {ROLE_CATEGORIES.filter(([key]) => key !== form.roleCategory).map(([key, label]) => (
                <Checkbox key={key} label={label} checked={form.extras.includes(key)}
                  disabled={!form.extras.includes(key) && form.extras.filter(k => k !== form.roleCategory).length >= 4}
                  onChange={e => setForm(f => ({ ...f, extras: e.target.checked ? [...f.extras, key] : f.extras.filter(k => k !== key) }))} />
              ))}
            </div>
          </fieldset>
        )}
        <Input label="Role title (optional)" value={form.roleTitle} onChange={set('roleTitle')} />
        {mode === 'add' && (
          <Textarea id="lead-form-notes" label="Notes (optional)" value={form.notes} onChange={set('notes')} rows={3} maxLength={2000} />
        )}
        {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
        {needsOverride && (
          <Button variant="danger" onClick={() => submit({ override: true })} disabled={saving}>
            They've asked me to add them — add anyway
          </Button>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" loading={saving}>{mode === 'add' ? 'Add lead' : 'Save'}</Button>
        </div>
      </Form>
    </Modal>
  )
}

// ── CSV import ──────────────────────────────────────────────────────────────

// Pick a file, tick that these people asked to hear from you, check it (nothing is saved), then import.
// Rows go up in batches of 200; each batch reports what it skipped and why.
function ImportLeadsModal({ open, onClose, onDone }) {
  const [rows, setRows] = useState([])
  const [fileName, setFileName] = useState('')
  const [parseError, setParseError] = useState('')
  const [attest, setAttest] = useState(false)
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState(null)   // result of the last check
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setRows([]); setFileName(''); setParseError(''); setAttest(false); setBusy(false); setReport(null); setError('')
  }, [open])

  async function onFile(e) {
    const file = e.target.files?.[0]
    setReport(null); setError('')
    if (!file) return
    setFileName(file.name)
    const parsed = leadRowsFromCsv(await file.text())
    setRows(parsed.rows); setParseError(parsed.error || '')
  }

  async function run(dryRun) {
    setBusy(true); setError('')
    const total = { created: 0, wouldCreate: 0, invalid: 0, duplicateInFile: 0, exists: 0, removed: 0, fieldIgnored: 0, problems: [] }
    try {
      let offset = 0
      for (const batch of chunk(rows)) {
        const res = await api.post('/employer-leads/import', { rows: batch, attest: true, dryRun })
        const d = res.data.data
        for (const k of ['created', 'wouldCreate', 'invalid', 'duplicateInFile', 'exists', 'removed', 'fieldIgnored']) total[k] += d[k]
        total.problems.push(...d.problems.map(p => ({ ...p, line: p.line ? p.line + offset : p.line })))
        offset += batch.length
      }
      if (dryRun) setReport(total)
      else onDone(total.created)
    } catch (err) {
      setError(getErrorMessage(err, 'The import failed part-way. Check the list before trying again — leads already imported are skipped.'))
    } finally {
      setBusy(false)
    }
  }

  const skipped = report ? report.invalid + report.duplicateInFile + report.exists + report.removed : 0
  return (
    <Modal open={open} onClose={onClose} title="Import leads from CSV" dismissible={!busy}>
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-gray-500">
          Columns: <b>name</b>, <b>company</b>, <b>email</b>; optional <b>field</b>, <b>role</b>, <b>notes</b>. Imported leads
          count as confirmed and nobody is emailed. Addresses that asked to be removed, and addresses that are already
          leads, are skipped.
        </p>
        <input type="file" accept=".csv,text/csv" onChange={onFile} disabled={busy} aria-label="CSV file" />
        {parseError && <p role="alert" className="text-red-600">{parseError}</p>}
        {rows.length > 0 && !parseError && <p className="text-gray-600">{fileName}: {rows.length} row{rows.length === 1 ? '' : 's'} found.</p>}
        <Checkbox label="These contacts asked to hear from Passthrough (or I am allowed to contact them about it)."
          checked={attest} onChange={e => { setAttest(e.target.checked); setReport(null) }} />
        {report && (
          <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2">
            <p className="font-medium text-gray-900">{report.wouldCreate} would be imported{skipped ? `, ${skipped} skipped` : ''}.</p>
            <p className="text-gray-500">
              {[report.invalid && `${report.invalid} invalid`, report.duplicateInFile && `${report.duplicateInFile} repeated in the file`,
                report.exists && `${report.exists} already leads`, report.removed && `${report.removed} asked to be removed`,
                report.fieldIgnored && `${report.fieldIgnored} with an unknown field (imported without one)`].filter(Boolean).join(' · ') || 'No problems found.'}
            </p>
            {report.problems.length > 0 && (
              <ul className="mt-2 max-h-40 overflow-y-auto text-xs text-gray-600 list-disc pl-4">
                {report.problems.slice(0, 50).map((p, i) => <li key={i}>{p.line ? `Row ${p.line}` : 'Row'}{p.email ? ` (${p.email})` : ''}: {p.reason}</li>)}
              </ul>
            )}
          </div>
        )}
        {error && <p role="alert" className="text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="secondary" loading={busy && !report} disabled={!rows.length || !!parseError || !attest || busy} onClick={() => run(true)}>Check file</Button>
          <Button loading={busy && !!report} disabled={!report || !report.wouldCreate || busy} onClick={() => run(false)}>
            Import{report ? ` ${report.wouldCreate}` : ''}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
