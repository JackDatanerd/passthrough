import { useEffect, useState, useRef } from 'react'
import { useParams, useSearchParams, Link, useNavigate } from 'react-router-dom'
import api from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'
import ScoreGauge from '../components/scan/ScoreGauge'
import CategoryScores from '../components/scan/CategoryScores'
import FixBanner from '../components/scan/FixBanner'
import Spinner from '../components/ui/Spinner'
import Button from '../components/ui/Button'
import { statusLabel, formatDate } from '../lib/utils'

const TERMINAL = ['COMPLETE_PASS', 'COMPLETE_FAIL', 'FIX_PURCHASED', 'FIX_GENERATING', 'FIX_DELIVERED', 'ERROR']
const POLL_MS  = 2500

export default function ScanResult() {
  const { id }        = useParams()
  const [params]      = useSearchParams()
  const navigate      = useNavigate()
  const { user }      = useAuth()
  const anonToken     = params.get('token') || localStorage.getItem('passthrough_anon_token')
  const [scan,        setScan      ] = useState(null)
  const [loading,     setLoading   ] = useState(true)
  const [payLoading,  setPayLoading] = useState(false)
  const [payError,    setPayError  ] = useState('')
  const [dlError,     setDlError   ] = useState('')
  const pollRef = useRef(null)

  async function fetchScan() {
    try {
      const url    = `/scan/${id}${anonToken ? `?token=${anonToken}` : ''}`
      const res    = await api.get(url)
      const data   = res.data.data
      setScan(data)
      setLoading(false)
      if (TERMINAL.includes(data.status)) {
        clearInterval(pollRef.current)
      }
    } catch (err) {
      setLoading(false)
      clearInterval(pollRef.current)
    }
  }

  useEffect(() => {
    fetchScan()
    pollRef.current = setInterval(fetchScan, POLL_MS)
    return () => clearInterval(pollRef.current)
  }, [id])

  async function handlePay(fixTier) {
    if (!user) return navigate(`/register`)
    setPayLoading(true); setPayError('')
    try {
      const res = await api.post('/payments/initialize', { scanId: id, fixTier })
      window.location.href = res.data.data.authorization_url
    } catch (err) {
      setPayError(err.response?.data?.message || 'Payment failed to initialize.')
      setPayLoading(false)
    }
  }

  async function handleDownload(type) {
    setDlError('')
    try {
      const res = await api.get(`/scan/${id}/download?type=${type}`, { responseType: 'blob' })
      const url = URL.createObjectURL(res.data)
      const a   = document.createElement('a')
      a.href    = url
      a.download = type === 'ats' ? 'resume-ats.docx' : 'resume-verified.pdf'
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      const code = err.response?.data?.code
      if (code === 'EMAIL_NOT_VERIFIED') {
        setDlError('Please verify your email before downloading. Check your inbox.')
      } else {
        setDlError(err.response?.data?.message || 'Download failed.')
      }
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col bg-gray-50">
        <Navbar />
        <main className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <Spinner size="lg" className="mx-auto mb-4" />
            <p className="text-gray-500 text-sm">Loading scan…</p>
          </div>
        </main>
        <Footer />
      </div>
    )
  }

  if (!scan) {
    return (
      <div className="min-h-screen flex flex-col bg-gray-50">
        <Navbar />
        <main className="flex-1 flex items-center justify-center px-4">
          <div className="text-center">
            <p className="text-gray-600 mb-4">Scan not found or access denied.</p>
            <Link to="/" className="text-blue-600 hover:underline text-sm">Start a new scan</Link>
          </div>
        </main>
        <Footer />
      </div>
    )
  }

  const scanning = !TERMINAL.includes(scan.status) || scan.status === 'PENDING'

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <Navbar />
      <main className="max-w-3xl mx-auto px-4 py-10 w-full">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">
            {scan.resumeOriginalName || 'Resume scan'}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {formatDate(scan.createdAt)} · {statusLabel(scan.status)}
          </p>
        </div>

        {/* Scanning state */}
        {scanning && (
          <div className="bg-white rounded-xl border border-gray-200 p-10 text-center shadow-sm">
            <Spinner size="lg" className="mx-auto mb-4" />
            <p className="font-medium text-gray-700">Scanning your resume…</p>
            <p className="text-sm text-gray-400 mt-1">This takes about 30 seconds</p>
          </div>
        )}

        {/* Error state */}
        {scan.status === 'ERROR' && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-center">
            <p className="font-medium text-red-800 mb-1">Scan failed</p>
            <p className="text-sm text-red-600">We couldn't parse your resume. Try uploading a text-based PDF or .docx.</p>
            <Link to="/" className="mt-4 inline-block text-sm text-blue-600 hover:underline">Try again</Link>
          </div>
        )}

        {/* Results */}
        {['COMPLETE_PASS', 'COMPLETE_FAIL', 'FIX_PURCHASED', 'FIX_GENERATING', 'FIX_DELIVERED'].includes(scan.status) && (
          <div className="flex flex-col gap-6">
            {/* Score card */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 sm:p-8">
              <div className="flex flex-col sm:flex-row items-center gap-8">
                <ScoreGauge score={scan.atsScore} />
                <div className="flex-1 w-full">
                  <h2 className="text-lg font-semibold text-gray-900 mb-4">
                    {scan.passed ? 'Your resume passed ATS screening' : 'Your resume is failing ATS filters'}
                  </h2>
                  <CategoryScores scan={scan} />
                </div>
              </div>
            </div>

            {/* Fix generating */}
            {['FIX_PURCHASED', 'FIX_GENERATING'].includes(scan.status) && (
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-6 flex items-center gap-4">
                <Spinner className="shrink-0" />
                <div>
                  <p className="font-medium text-blue-900">Generating your fixed resume…</p>
                  <p className="text-sm text-blue-700 mt-0.5">We'll email you when it's ready. Usually under 2 minutes.</p>
                </div>
              </div>
            )}

            {/* Delivered */}
            {scan.status === 'FIX_DELIVERED' && (
              <div className="bg-green-50 border border-green-200 rounded-xl p-6">
                <p className="font-semibold text-green-900 mb-1">✓ Your Passthrough Verified resume is ready</p>
                {scan.verificationUrl && (
                  <p className="text-sm text-green-800 mb-4">
                    Verification URL:{' '}
                    <a href={scan.verificationUrl} target="_blank" rel="noreferrer"
                      className="underline break-all">
                      {scan.verificationUrl}
                    </a>
                  </p>
                )}
                {dlError && (
                  <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2 mb-3">
                    {dlError}
                  </p>
                )}
                <div className="flex flex-col sm:flex-row gap-3">
                  <Button onClick={() => handleDownload('ats')} variant="secondary">
                    Download .docx (ATS)
                  </Button>
                  <Button onClick={() => handleDownload('pdf')}>
                    Download PDF (beautiful)
                  </Button>
                </div>
              </div>
            )}

            {/* Fix banner — only when not yet purchased */}
            {!scan.fixPurchased && (
              <>
                {payError && (
                  <p className="text-sm text-red-600">{payError}</p>
                )}
                <FixBanner scan={scan} onPay={handlePay} />
              </>
            )}

            {/* Register nudge for anon users */}
            {!user && !scan.fixPurchased && (
              <div className="bg-gray-50 border border-gray-200 rounded-xl p-5 text-sm text-gray-600">
                <p className="font-medium text-gray-800 mb-1">Save your results</p>
                <p className="mb-3">Create a free account to keep your scan history and buy a fix.</p>
                <Link to="/register"
                  className="inline-block bg-blue-700 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-800 transition-colors">
                  Create free account →
                </Link>
              </div>
            )}
          </div>
        )}
      </main>
      <Footer />
    </div>
  )
}
