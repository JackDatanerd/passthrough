import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../../lib/api'
import Button from '../ui/Button'
import Input from '../ui/Input'
import Textarea from '../ui/Textarea'
import FileUpload from '../ui/FileUpload'

export default function ScanForm() {
  const navigate  = useNavigate()
  const [file,    setFile   ] = useState(null)
  const [useUrl,  setUseUrl ] = useState(false)
  const [jobUrl,  setJobUrl ] = useState('')
  const [jdText,  setJdText ] = useState('')
  const [loading, setLoading] = useState(false)
  const [error,   setError  ] = useState('')

  async function handleSubmit() {
    if (!file)                      return setError('Please upload your resume.')
    if (!useUrl && jdText.length < 50) return setError('Job description too short (min 50 characters).')
    if (useUrl  && !jobUrl.trim())  return setError('Please enter a job posting URL.')
    setError('')
    setLoading(true)
    try {
      const formData = new FormData()
      formData.append('resume', file)
      if (useUrl && jobUrl.trim())
        formData.append('jobDescriptionUrl', jobUrl.trim())
      else
        formData.append('jobDescriptionText', jdText)

      const res = await api.post('/scan', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      })
      const { scanId, anonToken } = res.data.data

      // CRITICAL: store anonToken so postRegisterActions can claim this scan
      if (anonToken) localStorage.setItem('passthrough_anon_token', anonToken)

      navigate(`/scan/${scanId}`)
    } catch (err) {
      const msg = err.response?.data?.message || 'Something went wrong. Please try again.'
      if (err.response?.data?.blocked) {
        setUseUrl(false)
        setError(msg)
      } else {
        setError(msg)
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <FileUpload onFile={setFile} />

      <div>
        <div className="flex items-center gap-4 mb-3">
          <span className="text-sm font-medium text-gray-700">Job description</span>
          <div className="flex rounded-md overflow-hidden border border-gray-300 text-sm">
            <button
              onClick={() => setUseUrl(false)}
              className={`px-3 py-1.5 transition-colors ${!useUrl ? 'bg-blue-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
            >
              Paste text
            </button>
            <button
              onClick={() => setUseUrl(true)}
              className={`px-3 py-1.5 transition-colors ${useUrl ? 'bg-blue-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
            >
              URL
            </button>
          </div>
        </div>

        {useUrl ? (
          <div>
            <Input
              placeholder="https://jobs.example.com/software-engineer-123"
              value={jobUrl}
              onChange={e => setJobUrl(e.target.value)}
            />
            <p className="mt-1 text-xs text-gray-500">
              LinkedIn URLs cannot be read automatically — paste the text instead.
            </p>
          </div>
        ) : (
          <Textarea
            placeholder="Paste the full job description here…"
            value={jdText}
            onChange={e => setJdText(e.target.value)}
            rows={7}
          />
        )}
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      <Button onClick={handleSubmit} loading={loading} size="lg" className="w-full sm:w-auto">
        Scan My Resume — Free
      </Button>
      <p className="text-xs text-gray-500">
        No account needed. Results in ~30 seconds.
      </p>
    </div>
  )
}
