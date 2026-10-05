import { useEffect, useRef } from 'react'

// Cloudflare Turnstile bot challenge for the public employer-lead forms.
//
// Opt-in by configuration: with no VITE_TURNSTILE_SITE_KEY this renders nothing and the
// forms behave exactly as they did before. A deployment turns the challenge on by setting
// that key here AND TURNSTILE_SECRET_KEY on the API (the API only demands a token when its
// own secret is set, so enabling one side without the other is safe, just inert).
//
// `resetSignal` is a counter the parent bumps after a failed submission: a Turnstile token
// is single-use, so the next attempt needs a fresh one.
export const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || ''
export const TURNSTILE_ENABLED = !!TURNSTILE_SITE_KEY

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
let scriptPromise = null

function loadScript() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'))
  if (window.turnstile) return Promise.resolve(window.turnstile)
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const el = document.createElement('script')
      el.src = SCRIPT_SRC
      el.async = true
      el.defer = true
      el.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile missing')))
      el.onerror = () => { scriptPromise = null; reject(new Error('turnstile failed to load')) }
      document.head.appendChild(el)
    })
  }
  return scriptPromise
}

export default function TurnstileWidget({ onToken, resetSignal = 0 }) {
  const box = useRef(null)
  const widgetId = useRef(null)
  const onTokenRef = useRef(onToken)
  onTokenRef.current = onToken

  useEffect(() => {
    if (!TURNSTILE_ENABLED) return undefined
    let cancelled = false
    loadScript().then(ts => {
      if (cancelled || !box.current || widgetId.current != null) return
      widgetId.current = ts.render(box.current, {
        sitekey: TURNSTILE_SITE_KEY,
        callback: token => onTokenRef.current(token),
        'expired-callback': () => onTokenRef.current(''),
        'error-callback': () => onTokenRef.current('')
      })
    }).catch(() => onTokenRef.current(''))
    return () => {
      cancelled = true
      if (widgetId.current != null && window.turnstile) {
        try { window.turnstile.remove(widgetId.current) } catch (_) { /* already gone */ }
      }
      widgetId.current = null
    }
  }, [])

  useEffect(() => {
    if (!resetSignal || widgetId.current == null || !window.turnstile) return
    try { window.turnstile.reset(widgetId.current) } catch (_) { /* widget removed */ }
    onTokenRef.current('')
  }, [resetSignal])

  if (!TURNSTILE_ENABLED) return null
  return <div ref={box} data-testid="turnstile-box" />
}
