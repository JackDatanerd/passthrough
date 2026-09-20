import { useEffect, useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import api from '../lib/api'
import Spinner from '../components/ui/Spinner'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'

export default function PaymentSuccess() {
  const [params]  = useSearchParams()
  const navigate  = useNavigate()
  const [status,  setStatus ] = useState('loading') // loading | success | error
  const [scanId,  setScanId ] = useState(null)

  const reference = params.get('reference') || params.get('trxref')

  // BUGFIX: previously any failure here — a network blip, a brief 5xx,
  // even a genuine amount-mismatch 400 — collapsed into the same
  // permanent "Verification failed" screen with no way to retry short of
  // navigating away. verifyPayment is a LIVE call out to Paystack, not
  // just a DB read, so a single transient hiccup on that one request
  // shouldn't be able to strand someone who legitimately just paid. One
  // automatic retry handles the transient case silently; a manual "Try
  // again" button covers anything slower than that without forcing a full
  // page reload.
  function verify(attempt = 1) {
    if (!reference) { setStatus('error'); return }
    setStatus('loading')
    api.get(`/payments/verify?reference=${reference}`)
      .then(res => {
        const sid = res.data.data.scanId
        setScanId(sid)
        setStatus('success')
        setTimeout(() => navigate(`/scan/${sid}`), 2000)
      })
      .catch(() => {
        if (attempt < 2) { setTimeout(() => verify(attempt + 1), 1500); return }
        setStatus('error')
      })
  }

  useEffect(() => { verify() }, [])

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <Navbar />
      <main className="flex-1 flex items-center justify-center px-4">
        <div className="w-full max-w-sm bg-white rounded-xl border border-gray-200 shadow-sm p-8 text-center">
          {status === 'loading' && (
            <>
              <Spinner size="lg" className="mx-auto mb-4" />
              <p className="text-gray-600">Confirming your payment…</p>
            </>
          )}
          {status === 'success' && (
            <>
              <div className="text-green-500 text-5xl mb-4">✓</div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">Payment confirmed!</h1>
              <p className="text-sm text-gray-500">
                Generating your resume. Redirecting…
              </p>
            </>
          )}
          {status === 'error' && (
            <>
              <div className="text-red-500 text-5xl mb-4">✕</div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">Verification failed</h1>
              <p className="text-sm text-gray-500 mb-4">
                Your payment may still have gone through. Try again, check your dashboard, or email us at support@passthrough.dev.
              </p>
              <div className="flex items-center justify-center gap-4">
                <button type="button" onClick={() => verify()} className="text-sm text-blue-600 hover:underline">
                  Try again
                </button>
                <a href="/dashboard" className="text-sm text-blue-600 hover:underline">
                  Go to dashboard
                </a>
              </div>
            </>
          )}
        </div>
      </main>
      <Footer />
    </div>
  )
}
