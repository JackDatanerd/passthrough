import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api, { getErrorMessage } from '../../lib/api'
import DashboardLayout from '../../components/layout/DashboardLayout'
import Button from '../../components/ui/Button'
import Spinner from '../../components/ui/Spinner'
import CredentialCard from '../../components/dashboard/CredentialCard'
import { ATS_PASS_THRESHOLD, ATS_BADGE_THRESHOLD } from '../../lib/scoreThresholds'
import { scanHeading } from '../../lib/scanDisplay'
import { displayScore, isVerified, pointsTo, scanNeed } from '../../lib/scanNext'

// The highest-scoring scans cover both halves of this page: the Verified links, and the scans that are
// close to one. (The API returns at most 100 per request.)
const LIMIT = 100

export default function Proof() {
  const [scans, setScans] = useState(null)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setError('')
    api.get('/scan/history', { params: { limit: LIMIT, sort: 'score_desc' } })
      .then(res => { if (!cancelled) setScans(res.data.data.scans || []) })
      .catch(err => { if (!cancelled) setError(getErrorMessage(err, "Couldn't load your credentials.")) })
    return () => { cancelled = true }
  }, [tick])

  const verified = (scans || []).filter(isVerified)
  const almost = (scans || [])
    .filter(s => ['fix', 'retryfix'].includes(scanNeed(s)) && displayScore(s) >= ATS_PASS_THRESHOLD && displayScore(s) < ATS_BADGE_THRESHOLD)
    .sort((a, b) => pointsTo(a, ATS_BADGE_THRESHOLD) - pointsTo(b, ATS_BADGE_THRESHOLD))

  return (
    <DashboardLayout>
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Proof</h1>
          <p className="text-sm text-gray-600 mt-1">Your Verified links, ready to paste into an email signature or LinkedIn. An employer who opens one can check their copy of your resume against what Passthrough issued. It is not an employer endorsement.</p>
        </div>

        {!scans && !error && <div className="flex justify-center py-12"><Spinner size="lg" /></div>}

        {error && (
          <div role="alert" className="text-center py-12 border border-red-200 bg-red-50 rounded-xl">
            <p className="text-sm text-red-700 mb-4">{error}</p>
            <Button size="sm" variant="secondary" onClick={() => setTick(t => t + 1)}>Try again</Button>
          </div>
        )}

        {scans && (
          <>
            {verified.length > 0 ? (
              <div className="grid gap-3 md:grid-cols-2">{verified.map(s => <CredentialCard key={s.id} scan={s} />)}</div>
            ) : (
              <div className="rounded-xl border border-dashed border-gray-200 p-8 text-center">
                <p className="text-gray-600">No Verified links yet. Reach {ATS_BADGE_THRESHOLD} and the link appears here.</p>
                <Link to="/dashboard" className="inline-block mt-3 text-sm text-blue-700 hover:text-blue-900">Back to your scans</Link>
              </div>
            )}
            {almost.length > 0 && (
              <section aria-label="Almost there">
                <h2 className="text-base font-semibold text-gray-900">Almost there</h2>
                <p className="text-sm text-gray-600 mb-3">These are close to the credential line of {ATS_BADGE_THRESHOLD}.</p>
                <ul className="flex flex-col gap-2">
                  {almost.map(s => (
                    <li key={s.id} className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm">
                      <span><b className="font-medium text-gray-900">{scanHeading(s)}</b> <span className="text-gray-600">is {pointsTo(s, ATS_BADGE_THRESHOLD)} point{pointsTo(s, ATS_BADGE_THRESHOLD) === 1 ? '' : 's'} away ({displayScore(s)})</span></span>
                      <Link to={`/scan/${s.id}`} className="text-blue-700 hover:text-blue-900 shrink-0">Open</Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  )
}
