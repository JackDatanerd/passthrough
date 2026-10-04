import { useEffect, useState } from 'react'
import api, { getErrorMessage } from '../../lib/api'
import Button from '../ui/Button'
import { formatDateTime } from '../../lib/utils'
import { describeUserAgent } from '../../lib/userAgent'

// FEATURE GAP CLOSED (Auth round 2): GET /auth/sessions and
// DELETE /auth/sessions/:id (migration 0047) had no UI at all — the only thing
// Settings offered was "sign out everything else", with nothing to say WHICH
// session is the one you don't recognise. This lists the account's live
// sessions and signs a single one out.
//
// The current session has no button on purpose: signing THIS browser out is the
// normal Sign out in the navbar, and revoking it from here would just strand the
// tab on a dead token.
export default function SessionsCard({ reloadKey = 0 }) {
  const [sessions, setSessions] = useState(null)   // null = loading
  const [currentKnown, setCurrentKnown] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState(null)

  useEffect(() => {
    let cancelled = false
    setError('')
    api.get('/auth/sessions')
      .then(res => {
        if (cancelled) return
        setSessions(res.data?.data?.sessions || [])
        setCurrentKnown(res.data?.data?.currentSessionKnown !== false)
      })
      .catch(err => {
        if (cancelled) return
        setSessions([])
        setError(getErrorMessage(err, "Couldn't load your signed-in devices."))
      })
    return () => { cancelled = true }
  }, [reloadKey])

  async function revoke(id) {
    setBusyId(id); setError('')
    try {
      await api.delete(`/auth/sessions/${id}`)
      setSessions(list => (list || []).filter(s => s.id !== id))
    } catch (err) {
      // 404 = it was already gone (signed out elsewhere, expired): the list is just stale.
      if (err.response?.status === 404) setSessions(list => (list || []).filter(s => s.id !== id))
      else setError(getErrorMessage(err, "Couldn't sign that device out."))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <h2 className="font-semibold text-gray-900 mb-1">Signed-in devices</h2>
      <p className="text-sm text-gray-500 mb-4">
        Every browser or device currently signed in to your account. Sign out any you don't recognise.
      </p>

      {error && <p role="alert" className="text-sm text-red-600 mb-3">{error}</p>}

      {sessions === null ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : sessions.length === 0 && !error ? (
        <p className="text-sm text-gray-400">No other signed-in devices.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-gray-100">
          {sessions.map(s => (
            <li key={s.id} className="py-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900">
                  {describeUserAgent(s.userAgent)}
                  {s.current && (
                    <span className="ml-2 align-middle text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded px-1.5 py-0.5">
                      This device
                    </span>
                  )}
                </p>
                <p className="text-xs text-gray-500">
                  Last active {formatDateTime(s.lastSeenAt)}
                  {s.ip && s.ip !== 'unknown' && <> · <span className="font-mono">{s.ip}</span></>}
                </p>
                <p className="text-xs text-gray-400">Signed in {formatDateTime(s.createdAt)}</p>
              </div>
              {!s.current && (
                <Button type="button" size="sm" variant="secondary"
                  loading={busyId === s.id} disabled={busyId !== null}
                  onClick={() => revoke(s.id)}>
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!currentKnown && sessions !== null && (
        <p className="text-xs text-gray-400 mt-3">
          This browser is still on an older sign-in and will appear here after your next page load.
        </p>
      )}
    </div>
  )
}
