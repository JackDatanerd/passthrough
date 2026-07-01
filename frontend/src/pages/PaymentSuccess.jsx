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

  useEffect(() => {
    const reference = params.get('reference') || params.get('trxref')
    if (!reference) { setStatus('error'); return }
    api.get(`/payments/verify?reference=${reference}`)
      .then(res => {
        const sid = res.data.data.scanId
        setScanId(sid)
        setStatus('success')
        setTimeout(() => navigate(`/scan/${sid}`), 2000)
      })
      .catch(() => setStatus('error'))
  }, [])

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
                Your payment may still have gone through. Check your dashboard or email us at support@passthrough.dev.
              </p>
              <a href="/dashboard" className="text-sm text-blue-600 hover:underline">
                Go to dashboard
              </a>
            </>
          )}
        </div>
      </main>
      <Footer />
    </div>
  )
}
