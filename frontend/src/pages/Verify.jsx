import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import api from '../lib/api'
import Button from '../components/ui/Button'
import Input from '../components/ui/Input'
import Spinner from '../components/ui/Spinner'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'
import { formatDate } from '../lib/utils'

export default function Verify() {
  const { code } = useParams()
  const [data,    setData   ] = useState(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  // Hiring manager soft opt-in
  const [hmExpanded,  setHmExpanded ] = useState(false)
  const [name,        setName       ] = useState('')
  const [company,     setCompany    ] = useState('')
  const [role,        setRole       ] = useState('')
  const [email,       setEmail      ] = useState('')
  const [leadSent,    setLeadSent   ] = useState(false)
  const [leadErr,     setLeadErr    ] = useState('')
  const [leadLoading, setLeadLoading] = useState(false)

  useEffect(() => {
    api.get(`/verify/${code}`)
      .then(res => { setData(res.data.data); setLoading(false) })
      .catch(err => {
        setLoading(false)
        if (err.response?.status === 404) setNotFound(true)
      })
  }, [code])

  async function handleLead() {
    if (!name || !company || !email) return setLeadErr('Name, company, and email required.')
    setLeadLoading(true); setLeadErr('')
    try {
      await api.post('/employer-leads', {
        name,
        company,
        email,
        roleCategory: role || undefined
      })
      setLeadSent(true)
    } catch (err) {
      setLeadErr(err.response?.data?.message || 'Something went wrong.')
    } finally {
      setLeadLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <Navbar />
      <main className="max-w-2xl mx-auto px-4 py-12 w-full">
        {loading && (
          <div className="flex justify-center py-20">
            <Spinner size="lg" />
          </div>
        )}

        {notFound && (
          <div className="text-center py-20">
            <p className="text-gray-600">Verification not found.</p>
          </div>
        )}

        {data && (
          <div className="flex flex-col gap-6">
            {/* Verification card */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-8 text-center">
              {data.passed ? (
                <>
                  <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
                    <span className="text-green-600 text-3xl">✓</span>
                  </div>
                  <h1 className="text-2xl font-bold text-gray-900 mb-1">
                    Passthrough Verified
                  </h1>
                </>
              ) : (
                <>
                  <div className="w-16 h-16 rounded-full bg-amber-100 flex items-center justify-center mx-auto mb-4">
                    <span className="text-amber-600 text-3xl">○</span>
                  </div>
                  <h1 className="text-2xl font-bold text-gray-900 mb-1">
                    Passthrough Scan Report
                  </h1>
                  <p className="text-sm text-amber-700 mb-1">
                    Below the Passthrough Verified threshold (80+)
                  </p>
                </>
              )}
              {data.candidateFirstName && (
                <p className="text-gray-500 text-lg mb-4">{data.candidateFirstName}</p>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-6 text-sm">
                <div className="bg-gray-50 rounded-lg p-3">
                  <p className="text-gray-400 text-xs mb-1">ATS Score</p>
                  <p className={`font-bold text-xl ${data.passed ? 'text-green-700' : 'text-red-600'}`}>
                    {data.atsScore}
                  </p>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <p className="text-gray-400 text-xs mb-1">Integrity</p>
                  <p className={`font-bold text-sm ${data.integrityStatus === 'verified' ? 'text-green-700' : 'text-red-600'}`}>
                    {data.integrityStatus === 'verified' ? 'Unmodified' : 'Modified'}
                  </p>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <p className="text-gray-400 text-xs mb-1">Field</p>
                  <p className="font-semibold text-gray-700 capitalize text-sm">
                    {data.roleCategory?.replace(/_/g, ' ') || '—'}
                  </p>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <p className="text-gray-400 text-xs mb-1">Verified</p>
                  <p className="font-semibold text-gray-700 text-sm">{formatDate(data.verifiedAt)}</p>
                </div>
              </div>
              <p className="text-xs text-gray-400 mt-6">
                {data.passed
                  ? "This resume was scanned by Passthrough's ATS engine and has not been modified since verification."
                  : "This resume was scanned by Passthrough's ATS engine. It has not been modified since this scan, but did not reach the score threshold required for Passthrough Verified status."}
              </p>
            </div>

            {/* Hiring manager soft opt-in — shown above the full form */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
              {leadSent ? (
                <p className="text-sm text-green-700 font-medium">
                  You're on the list.
                </p>
              ) : !hmExpanded ? (
                /* Collapsed trigger */
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <p className="text-sm text-gray-500">Are you a hiring manager?</p>
                  <button
                    onClick={() => setHmExpanded(true)}
                    className="text-sm font-medium text-blue-700 hover:text-blue-800 underline underline-offset-2 transition-colors"
                  >
                    Get early access to Verified candidates →
                  </button>
                </div>
              ) : (
                /* Expanded form */
                <div className="flex flex-col gap-3">
                  <div>
                    <h2 className="font-semibold text-gray-900 mb-0.5">Get early access to Verified candidates</h2>
                    <p className="text-sm text-gray-500">We'll reach out when we have candidates matching your role.</p>
                  </div>
                  <Input
                    placeholder="Your name"
                    value={name}
                    onChange={e => setName(e.target.value)}
                  />
                  <Input
                    placeholder="Company"
                    value={company}
                    onChange={e => setCompany(e.target.value)}
                  />
                  <Input
                    placeholder="Role you're hiring for (e.g. Senior Engineer)"
                    value={role}
                    onChange={e => setRole(e.target.value)}
                  />
                  <Input
                    type="email"
                    placeholder="Work email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                  />
                  {leadErr && <p className="text-xs text-red-600">{leadErr}</p>}
                  <div className="flex gap-3">
                    <Button onClick={handleLead} loading={leadLoading}>
                      Get early access
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setHmExpanded(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
      <Footer />
    </div>
  )
}
