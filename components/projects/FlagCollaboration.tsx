// components/projects/FlagCollaboration.tsx
//
// Governance-scoped collaboration for a single guardian_flags row (or an
// exceptions_log row, via entityType='exception'). Deliberately narrow —
// this is audit rationale ("why was this resolved/granted"), not a
// general comment thread. No @mentions, no reactions, no editing history.

'use client'
import { useState, useEffect, useRef } from 'react'
import { formatRelative } from '@/lib/utils/format'

interface Comment {
  id: string; body: string; createdAt: string
  authorId: string; authorName: string; authorAvatarUrl: string | null
}
interface Attachment {
  id: string; fileName: string; fileSize: number; mimeType: string
  uploadedAt: string; uploadedByName: string; downloadUrl: string | null
}

function fileIcon(mime: string): string {
  if (mime.startsWith('image/')) return 'ti-photo'
  if (mime === 'application/pdf') return 'ti-file-type-pdf'
  if (mime === 'message/rfc822') return 'ti-mail'
  return 'ti-file'
}
function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// FIX (Projects & Dashboard pass 10, B2): the write handlers called res.json() bare inside try/finally with no catch. A dropped connection
// (fetch rejects) or a gateway/413 page (non-JSON body) became an unhandled rejection: the spinner stopped and the person saw nothing, so a
// note or a piece of evidence looked posted when it was not. Parse defensively and surface a message in every case.
async function readJson(res: Response): Promise<any> {
  return res.json().catch(() => ({}))
}
const NETWORK_ERROR = 'Could not reach the server. Check your connection and try again.'

export default function FlagCollaboration({
  entityType, entityId, canWrite,
}: { entityType: 'flag' | 'exception'; entityId: string; canWrite: boolean }) {
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  // FIX (Guardian section 13, pass 16 - B-E): a role with none of the governance-view permissions got a permanent 403 rendered as a
  // retryable load error. A 403 is a definitive "not for you", so the panel is hidden instead of offering a Retry that cannot succeed.
  const [forbidden, setForbidden] = useState(false)
  const [comments, setComments] = useState<Comment[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [draft, setDraft] = useState('')
  const [posting, setPosting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const base = `/api/scope-governance/${entityType}/${entityId}`

  async function load() {
    setLoadFailed(false)
    try {
      const [cRes, aRes] = await Promise.all([
        fetch(`${base}/comments`), fetch(`${base}/attachments`),
      ])
      // FIX (section 13 pass, B1): a non-2xx used to be read as "nothing here" (json.comments || []), so a 403/500
      // showed "No notes or evidence attached yet" with the composer open — evidence looked deleted. A non-JSON
      // body threw into a catch whose message only rendered inside the loaded branch, i.e. never: the panel sat on
      // "Loading…" forever. A failed read is now an explicit, retryable error state.
      if (cRes.status === 403 || aRes.status === 403) { setForbidden(true); return }
      if (!cRes.ok || !aRes.ok) throw new Error('load failed')
      const [cJson, aJson] = await Promise.all([cRes.json(), aRes.json()])
      setComments(cJson.comments || [])
      setAttachments(aJson.attachments || [])
      setError('')
      setLoaded(true)
    } catch {
      setLoadFailed(true)
      setError('Could not load notes and evidence.')
    }
  }

  useEffect(() => { if (open && !loaded) load() }, [open, loaded]) // eslint-disable-line

  async function submitComment() {
    const body = draft.trim()
    if (!body) return
    setPosting(true); setError('')
    try {
      const res = await fetch(`${base}/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      })
      const json = await readJson(res)
      if (!res.ok || !json.comment) { setError(json.error || 'Could not post comment.'); return }
      setComments(prev => [...prev, json.comment])
      setDraft('')
    } catch {
      setError(NETWORK_ERROR)
    } finally { setPosting(false) }
  }

  async function submitFile(file: File) {
    setUploading(true); setError('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(`${base}/attachments`, { method: 'POST', body: fd })
      const json = await readJson(res)
      if (!res.ok || !json.attachment) {
        setError(json.error || (res.status === 413 ? 'That file is too large to upload (4 MB max).' : 'Could not upload file.'))
        return
      }
      setAttachments(prev => [json.attachment, ...prev])
    } catch {
      setError(NETWORK_ERROR)
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  // FEATURE (deep audit, section 13): attachments could be uploaded but
  // never removed — a wrong file or a file meant for a different flag was
  // permanent. Gated the same as upload (canWrite — APPROVE_FLAGS or
  // GRANT_EXCEPTIONS), enforced again server-side.
  const [deletingId, setDeletingId] = useState<string | null>(null)
  async function deleteAttachment(id: string) {
    if (!confirm('Remove this attachment? This cannot be undone.')) return
    setDeletingId(id); setError('')
    try {
      const res = await fetch(`${base}/attachments/${id}`, { method: 'DELETE' })
      const json = await readJson(res)
      if (!res.ok) { setError(json.error || 'Could not remove attachment.'); return }
      setAttachments(prev => prev.filter(a => a.id !== id))
    } catch {
      setError(NETWORK_ERROR)
    } finally { setDeletingId(null) }
  }

  if (forbidden) return null

  const activityCount = (loaded ? comments.length + attachments.length : null)

  return (
    <div style={{ borderTop: '1px solid var(--surface-2)', marginTop: 10, paddingTop: 10 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none',
          padding: 0, cursor: 'pointer', fontSize: 11.5, color: 'var(--text-3)', fontWeight: 500,
        }}
      >
        <i className={`ti ${open ? 'ti-chevron-down' : 'ti-chevron-right'}`} style={{ fontSize: 11 }} />
        <i className="ti ti-message-2-share" style={{ fontSize: 12 }} />
        Notes & evidence{activityCount !== null && activityCount > 0 ? ` (${activityCount})` : ''}
      </button>

      {open && (
        <div style={{ marginTop: 10, paddingLeft: 4 }}>
          {!loaded ? (
            loadFailed ? (
              <div style={{ fontSize: 12, color: 'var(--red)', padding: '6px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>{error || 'Could not load notes and evidence.'}</span>
                <button className="btn btn-ghost btn-xs" onClick={() => load()}>Retry</button>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '6px 0' }}>Loading…</div>
            )
          ) : (
            <>
              {comments.length === 0 && attachments.length === 0 && (
                <p style={{ fontSize: 12, color: 'var(--text-4)', marginBottom: 10 }}>
                  No notes or evidence attached yet.
                </p>
              )}

              {comments.map(c => (
                <div key={c.id} style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                  <div style={{
                    width: 22, height: 22, borderRadius: '50%', background: 'var(--surface-2)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    fontSize: 9.5, fontWeight: 600, color: 'var(--text-2)',
                  }}>
                    {c.authorName.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11.5 }}>
                      <strong style={{ color: 'var(--text-1)' }}>{c.authorName}</strong>{' '}
                      <span style={{ color: 'var(--text-4)' }}>{formatRelative(c.createdAt)}</span>
                    </div>
                    <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5, marginTop: 2 }}>
                      {c.body}
                    </div>
                  </div>
                </div>
              ))}

              {attachments.map(a => (
                <div key={a.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', marginBottom: 6,
                    background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)',
                  }}>
                  <a href={a.downloadUrl || '#'} target="_blank" rel="noreferrer"
                    style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, textDecoration: 'none' }}>
                    <i className={`ti ${fileIcon(a.mimeType)}`} style={{ fontSize: 14, color: 'var(--text-3)' }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {a.fileName}
                      </div>
                      <div style={{ fontSize: 10.5, color: 'var(--text-4)' }}>
                        {fileSize(a.fileSize)} · {a.uploadedByName} · {formatRelative(a.uploadedAt)}
                      </div>
                    </div>
                    <i className="ti ti-download" style={{ fontSize: 12, color: 'var(--text-3)' }} />
                  </a>
                  {canWrite && (
                    <button
                      onClick={() => deleteAttachment(a.id)} disabled={deletingId === a.id}
                      title="Remove attachment"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, lineHeight: 0, flexShrink: 0 }}>
                      {deletingId === a.id
                        ? <span className="spin spin-dark" style={{ width: 11, height: 11 }} />
                        : <i className="ti ti-trash" style={{ fontSize: 12, color: 'var(--text-3)' }} />}
                    </button>
                  )}
                </div>
              ))}

              {error && <p style={{ fontSize: 11.5, color: 'var(--red)', marginBottom: 8 }}>{error}</p>}

              {canWrite && (
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <input
                    className="finp" value={draft} placeholder="Add a note explaining this decision…"
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && !posting) submitComment() }}
                    style={{ flex: 1, fontSize: 12.5 }}
                  />
                  <button className="btn btn-ghost btn-xs" disabled={posting || !draft.trim()} onClick={submitComment}>
                    {posting ? <span className="spin spin-dark" style={{ width: 11, height: 11 }} /> : 'Post'}
                  </button>
                  <input ref={fileRef} type="file" style={{ display: 'none' }}
                    onChange={e => e.target.files?.[0] && submitFile(e.target.files[0])} />
                  <button className="btn btn-ghost btn-xs" disabled={uploading} onClick={() => fileRef.current?.click()}
                    title="Attach evidence (PDF, image, email, doc — max 4 MB)">
                    {uploading ? <span className="spin spin-dark" style={{ width: 11, height: 11 }} /> : <i className="ti ti-paperclip" style={{ fontSize: 12 }} />}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
