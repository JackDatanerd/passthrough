import { useState, useEffect, useCallback } from 'react'
import api, { getErrorMessage } from '../../lib/api'
import Badge from '../../components/ui/Badge'
import Button from '../../components/ui/Button'
import Spinner from '../../components/ui/Spinner'
import Pagination from '../../components/ui/Pagination'
import Select from '../../components/ui/Select'
import ExpandableText, { previewOf } from '../../components/ui/ExpandableText'
import { useToast } from '../../components/ui/Toast'
import { formatDateTime } from '../../lib/utils'
import { roleLabel } from '../../lib/roleCategories'
import usePageClamp from '../../hooks/usePageClamp'
import useLatestRequest from '../../hooks/useLatestRequest'

const PAGE_SIZE = 25
const STATUSES = [['PENDING', 'Waiting for review'], ['APPROVED', 'Published'], ['REJECTED', 'Rejected']]

// Customer stories shown on the public homepage. Nothing appears there until it is approved here, and a
// published story can be taken down at any time (an author's edit also sends it back to PENDING). The
// decision is guarded on the exact text shown on this screen: if the author changes it while you read,
// the approval is refused and the list reloads, so approving never publishes words nobody reviewed.
export default function AdminStories() {
  const toast = useToast()
  const [status, setStatus] = useState('PENDING')
  const [stories, setStories] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  // Which stories' full text this reviewer has opened: scanId -> the exact text that was opened. It stays "read" if they collapse it
  // again, but a story its author edits while it is on screen counts as unread again (the text no longer matches).
  const [read, setRead] = useState({})
  const begin = useLatestRequest()

  const load = useCallback(async () => {
    const isCurrent = begin()
    setLoading(true)
    try {
      const res = await api.get('/admin/stories', { signal: isCurrent.signal, params: { status, page, pageSize: PAGE_SIZE } })
      if (!isCurrent()) return
      setStories(res.data.data.stories)
      setTotal(res.data.data.total)
    } catch (_) {
      if (!isCurrent()) return
      toast({ message: 'Failed to load stories.', type: 'error' })
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [status, page])
  useEffect(() => { load() }, [load])
  usePageClamp({ page, total, pageSize: PAGE_SIZE, setPage, loading })

  async function moderate(scanId, action) {
    setBusyId(scanId)
    try {
      await api.post(`/admin/stories/${encodeURIComponent(scanId)}/moderate`, { action })
      toast({ message: action === 'approve' ? 'Story approved — it can now appear on the homepage.' : 'Story rejected.', type: 'success' })
    } catch (err) {
      toast({ message: getErrorMessage(err, 'Could not update the story.'), type: 'error' })
    } finally {
      setBusyId(null)
      load()
    }
  }

  // A long story shows as a preview, and approving publishes the WHOLE text: it cannot be approved until its full text has been opened
  // here. Rejecting or taking down never needs a read.
  const unread = s => previewOf(s.text).truncated && read[s.scanId] !== s.text

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-bold text-gray-900">Customer stories</h1>
        <Select aria-label="Filter stories by status" size="sm" wrapperClassName="w-fit" value={status}
          onChange={e => { setPage(1); setStatus(e.target.value) }}>
          {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
      </div>
      <p className="text-xs text-gray-500">Stories customers chose to share after reporting an interview. Only approved stories reach the public homepage. Read for anything that is untrue, identifying, promotional or off-brand before approving.</p>
      {loading ? (
        <div className="flex justify-center py-8"><Spinner size="sm" /></div>
      ) : stories.length === 0 ? (
        <p className="text-sm text-gray-400 italic">Nothing here.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {stories.map(s => (
            <article key={s.scanId} className="border border-gray-200 rounded-lg bg-white p-4 text-sm">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <span className="font-semibold text-gray-900">{s.displayName}</span>
                {s.roleCategory && <Badge variant="gray">{roleLabel(s.roleCategory)}</Badge>}
                <Badge variant="blue">{s.interviewCount > 1 ? `${s.interviewCount} interviews` : 'Interview'}</Badge>
                {Number.isFinite(s.scoreBefore) && Number.isFinite(s.scoreAfter) && <Badge variant="gray">{s.scoreBefore} → {s.scoreAfter}</Badge>}
                <Badge variant={s.showCredential ? (s.credentialLive ? 'green' : 'amber') : 'gray'}>
                  {s.showCredential ? (s.credentialLive ? 'Links live credential' : 'Credential link requested — not live') : 'No credential link'}
                </Badge>
                {s.purchaseReversed && <Badge variant="red">Purchase refunded or disputed — never shown publicly</Badge>}
                <span className="text-xs text-gray-400 ml-auto">{formatDateTime(s.answeredAt)}</span>
              </div>
              <p className="font-medium text-gray-900">“{s.quote}”</p>
              <ExpandableText text={s.text} className="text-gray-700 mt-2 whitespace-pre-line"
                onToggle={open => { if (open) setRead(r => ({ ...r, [s.scanId]: s.text })) }} />
              <div className="mt-3 flex gap-2">
                {s.status !== 'APPROVED' && <Button size="sm" loading={busyId === s.scanId} disabled={unread(s)} onClick={() => moderate(s.scanId, 'approve')}>Approve</Button>}
                {s.status !== 'REJECTED' && <Button size="sm" variant="danger" pending={busyId === s.scanId} onClick={() => moderate(s.scanId, 'reject')}>{s.status === 'APPROVED' ? 'Take down' : 'Reject'}</Button>}
              </div>
              {s.status !== 'APPROVED' && unread(s) && (
                <p className="mt-2 text-xs text-amber-800" data-testid="read-to-approve">Open the full story to approve it. Approving publishes all of it.</p>
              )}
            </article>
          ))}
        </div>
      )}
      {totalPages > 1 && <Pagination page={page} totalPages={totalPages} onChange={setPage} compact className="flex items-center justify-center gap-3 mt-1" />}
    </div>
  )
}
