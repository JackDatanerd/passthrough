import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { getErrorMessage } from '../../lib/api'
import Button from '../ui/Button'

// FEATURE GAP CLOSED (Auth round 2): the API has told every signed-in client
// `termsCurrent` since the Terms version was recorded at sign-up, and
// POST /auth/accept-terms records fresh acceptance — but nothing in the app
// read the flag, so bumping TERMS_VERSION changed nothing anyone could see.
// Shown only when the server says the account's accepted version is stale
// (`termsCurrent === false`; an absent flag, or an account that predates the
// checkbox, never triggers it). Not blocking: it asks, it doesn't gate.
export default function TermsUpdateBanner() {
  const { user, acceptTerms } = useAuth()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const visible = !!user && user.termsCurrent === false
  const bannerRef = useRef(null)

  // The banner is fixed to the bottom edge, so it used to sit on top of the last
  // ~70px (all of the footer, on a phone) of every page until accepted. Reserve
  // its real height as bottom padding on <body>, and publish it as --bottom-inset
  // so the toast stack can clear it too.
  useEffect(() => {
    if (!visible) return
    const el = bannerRef.current
    if (!el) return
    const root = document.documentElement
    const apply = () => {
      const h = Math.ceil(el.getBoundingClientRect().height)
      document.body.style.paddingBottom = `${h}px`
      root.style.setProperty('--bottom-inset', `${h}px`)
    }
    apply()
    let ro
    if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(apply); ro.observe(el) }
    window.addEventListener('resize', apply)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', apply)
      document.body.style.paddingBottom = ''
      root.style.removeProperty('--bottom-inset')
    }
  }, [visible])

  if (!visible) return null

  async function handleAccept() {
    setLoading(true); setError('')
    try {
      await acceptTerms()
    } catch (err) {
      setError(getErrorMessage(err, "Couldn't record your acceptance. Please try again."))
      setLoading(false)
    }
    // On success the user object flips to termsCurrent: true and this unmounts.
  }

  return (
    <div ref={bannerRef} role="region" aria-label="Updated terms"
      className="fixed bottom-0 inset-x-0 z-40 bg-white border-t border-gray-200 shadow-lg">
      <div className="max-w-3xl mx-auto px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <p className="text-sm text-gray-700">
          We've updated our{' '}
          <Link to="/terms" target="_blank" className="text-blue-600 hover:underline">Terms of Service</Link>
          {' '}and{' '}
          <Link to="/privacy" target="_blank" className="text-blue-600 hover:underline">Privacy Policy</Link>.
          Please review and accept them to keep using your account.
          {error && <span role="alert" className="block text-red-600 mt-1">{error}</span>}
        </p>
        <Button type="button" size="sm" loading={loading} onClick={handleAccept} className="shrink-0">
          I agree
        </Button>
      </div>
    </div>
  )
}
