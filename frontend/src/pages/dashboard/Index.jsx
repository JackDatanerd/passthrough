import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../../lib/api'
import { useAuth } from '../../hooks/useAuth'
import DashboardLayout from '../../components/layout/DashboardLayout'
import Badge from '../../components/ui/Badge'
import Button from '../../components/ui/Button'
import Spinner from '../../components/ui/Spinner'
import { formatDate, statusLabel } from '../../lib/utils'

function scanBadgeVariant(status) {
  if (['COMPLETE_PASS', 'FIX_DELIVERED'].includes(status)) return 'green'
  if (status === 'COMPLETE_FAIL') return 'red'
  if (['FIX_PURCHASED', 'FIX_GENERATING'].includes(status)) return 'blue'
  if (status === 'ERROR') return 'red'
  return 'gray'
}

export default function DashboardIndex() {
  const { user } = useAuth()
  const [scans,    setScans   ] = useState([])
  const [loading,  setLoading ] = useState(true)
  const [resending, setResending] = useState(false)
  const [resentOk, setResentOk] = useState(false)

  useEffect(() => {
    api.get('/scan/history?page=1&limit=20')
      .then(res => { setScans(res.data.data.scans); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  async function resendVerification() {
    setResending(true)
    try {
      await api.post('/auth/resend-verification')
      setResentOk(true)
    } catch (_) {}
    setResending(false)
  }

  return (
    <DashboardLayout>
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-gray-900">Your scans</h1>
          <Link to="/"
            className="text-sm bg-blue-700 text-white px-4 py-2 rounded-md hover:bg-blue-800 transition-colors">
            New scan →
          </Link>
        </div>

        {/* Email verification banner */}
        {user && !user.emailVerified && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex flex-col sm:flex-row items-start sm:items-center gap-3">
            <div className="flex-1">
              <p className="text-sm font-medium text-amber-900">Verify your email to download files</p>
              <p className="text-xs text-amber-700 mt-0.5">Check your inbox for a verification email.</p>
            </div>
            {resentOk ? (
              <span className="text-xs text-green-700 bg-green-100 px-3 py-1.5 rounded-md">Sent!</span>
            ) : (
              <Button size="sm" variant="secondary" onClick={resendVerification} loading={resending}>
                Resend email
              </Button>
            )}
          </div>
        )}

        {loading && (
          <div className="flex justify-center py-12">
            <Spinner size="lg" />
          </div>
        )}

        {!loading && scans.length === 0 && (
          <div className="text-center py-16 border border-dashed border-gray-200 rounded-xl">
            <p className="text-gray-500 mb-4">No scans yet.</p>
            <Link to="/"
              className="inline-block bg-blue-700 text-white px-5 py-2.5 rounded-md text-sm font-medium hover:bg-blue-800 transition-colors">
              Scan your first resume →
            </Link>
          </div>
        )}

        {!loading && scans.length > 0 && (
          <div className="flex flex-col gap-3">
            {scans.map(scan => (
              <Link
                key={scan.id}
                to={`/scan/${scan.id}`}
                className="bg-white rounded-lg border border-gray-200 px-5 py-4 hover:border-blue-300 transition-colors flex flex-col sm:flex-row sm:items-center gap-3"
              >
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-900 truncate">
                    {scan.resumeOriginalName || 'Resume'}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">{formatDate(scan.createdAt)}</p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {scan.atsScore != null && (
                    <span className={`text-sm font-bold ${scan.atsScore >= 75 ? 'text-green-700' : scan.atsScore >= 50 ? 'text-amber-600' : 'text-red-600'}`}>
                      {scan.atsScore}/100
                    </span>
                  )}
                  <Badge variant={scanBadgeVariant(scan.status)}>
                    {statusLabel(scan.status)}
                  </Badge>
                  {scan.verificationCode && (
                    <span className="text-xs bg-green-100 text-green-800 px-2 py-0.5 rounded-full">
                      ✓ Verified
                    </span>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
