import { useState, useEffect, useCallback } from 'react'
import api from '../../lib/api'
import Spinner from '../../components/ui/Spinner'
import DataTable from '../../components/ui/DataTable'
import { useToast } from '../../components/ui/Toast'
import useLatestRequest from '../../hooks/useLatestRequest'
import { formatNumber } from '../../lib/utils'

// DATABASE ROUND 5 (feature gap): every delivered resume fix and cover letter is stamped with the prompt generation that wrote it, and
// people who got an interview (or not) answer a follow-up. The comparison that tells the owner whether a prompt change helped lived in a
// database view nobody could open without SQL. This is the read side: interview rate per prompt generation, with the sample size beside it
// — a rate over a handful of answers is shown, but marked, never presented as a result.
function pct(v) { return v === null || v === undefined ? '—' : `${v}%` }

function table(caption, rows, minResponses) {
  return (
    <DataTable
      caption={caption} density="compact"
      columns={[
        { key: 'version', header: 'Prompt version', cell: r => r.version || 'before versioning' },
        { key: 'responses', header: 'Answers', className: 'text-right', cell: r => formatNumber(r.responses) },
        { key: 'interviews', header: 'Interviews', className: 'text-right', cell: r => formatNumber(r.interviews) },
        { key: 'pct', header: 'Interview rate', className: 'text-right', cell: r => pct(r.interviewPct) },
        { key: 'note', header: '', cell: r => r.smallSample ? <span className="text-xs text-amber-700">under {minResponses} answers — not a result yet</span> : null },
      ]}
      rows={rows} rowKey={r => String(r.version)}
    />
  )
}

export default function AdminPromptOutcomes() {
  const toast = useToast()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [notReady, setNotReady] = useState(false)
  const begin = useLatestRequest()

  const load = useCallback(async () => {
    const isCurrent = begin()
    setLoading(true)
    setNotReady(false)
    try {
      const res = await api.get('/admin/prompt-outcomes')
      if (!isCurrent()) return
      setData(res.data.data)
    } catch (err) {
      if (!isCurrent()) return
      if (err?.response?.status === 503) setNotReady(true)
      else toast({ message: 'Failed to load prompt outcomes.', type: 'error' })
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold text-gray-900">Prompt outcomes</h1>
      <p className="text-xs text-gray-400">
        Interview rate by the prompt generation that wrote the delivered file. "Still applying" answers are left out of the rate.
      </p>
      {loading ? (
        <div className="flex justify-center py-8"><Spinner size="sm" /></div>
      ) : notReady ? (
        <p className="text-sm text-amber-700">Apply migration 0100 to see prompt outcomes.</p>
      ) : !data || (data.fix.length === 0 && data.letter.length === 0) ? (
        <p className="text-sm text-gray-400 italic">No interview answers recorded yet.</p>
      ) : (
        <>
          <h2 className="text-sm font-semibold text-gray-700 mt-2">Resume fix</h2>
          {data.fix.length ? table('Interview rate by resume prompt version', data.fix, data.minResponses) : <p className="text-sm text-gray-400 italic">No answers yet.</p>}
          <h2 className="text-sm font-semibold text-gray-700 mt-2">Cover letter</h2>
          {data.letter.length ? table('Interview rate by cover letter prompt version', data.letter, data.minResponses) : <p className="text-sm text-gray-400 italic">No answers yet.</p>}
        </>
      )}
    </div>
  )
}
