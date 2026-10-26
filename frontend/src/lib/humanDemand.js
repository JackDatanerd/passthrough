// Passthrough Experts, Phase 0A: the Human rewrite demand test (fake door). Browser side of /api/human-demand.
// Nothing here talks to checkout, pricing, codes or partners, and nothing here sends resume text, scan contents or contact
// details with an event. See docs/experts/STATUS.md.
import api from './api'

export const TIERS = ['polish', 'seven_day', 'forty_eight_hour', 'twenty_four_hour']
export const TIER_LABELS = {
  polish: 'Human polish',
  seven_day: 'Human rewrite, 7 days',
  forty_eight_hour: 'Human rewrite, 48 hours',
  twenty_four_hour: 'Human rewrite, 24 hours',
}
export const TIER_NOTES = {
  polish: 'An expert edits and checks the AI rewrite.',
  seven_day: 'An expert rewrites your resume. Delivered within 7 days.',
  forty_eight_hour: 'The same, delivered within 48 hours.',
  twenty_four_hour: 'The same, delivered within 24 hours.',
}

const VID_KEY = 'pt_hd_vid'
const CONFIG_KEY = 'pt_hd_cfg'
let memoryVid = null
let memoryConfig // undefined = not asked yet; null = flag off; object = on

// A random id for THIS browser (32 hex chars), kept in local storage so the visitor keeps one price variant. If storage is blocked
// the id lives for the page only (the variant can then change on reload; that is an accepted limit of the test).
export function getVisitorId() {
  try {
    const stored = window.localStorage.getItem(VID_KEY)
    if (stored && /^[a-f0-9]{32}$/.test(stored)) return stored
  } catch (_) { /* storage blocked */ }
  if (memoryVid) return memoryVid
  const bytes = new Uint8Array(16)
  window.crypto.getRandomValues(bytes)
  memoryVid = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  try { window.localStorage.setItem(VID_KEY, memoryVid) } catch (_) { /* storage blocked */ }
  return memoryVid
}

// Test hook only.
export function resetHumanDemandCache() { memoryConfig = undefined; memoryVid = null; try { window.sessionStorage.removeItem(CONFIG_KEY) } catch (_) { /* ignore */ } }

// null when the test is off for this visitor (the server answers 404 while the flag is off), else { variant, currency, prices, tiers }.
// One request per tab session: the answer, including "off", is remembered. A failed request (network, 5xx, 429) is NOT remembered
// as "off" beyond this page view, and shows nothing.
export async function loadHumanDemandConfig() {
  if (memoryConfig !== undefined) return memoryConfig
  try {
    const cached = window.sessionStorage.getItem(CONFIG_KEY)
    if (cached) { memoryConfig = JSON.parse(cached); return memoryConfig }
  } catch (_) { /* ignore */ }
  try {
    const res = await api.get('/human-demand/config', { params: { vid: getVisitorId() } })
    const data = res?.data?.data
    memoryConfig = data && data.variant && data.prices ? data : null
  } catch (err) {
    if (err?.response?.status === 404) memoryConfig = null
    else return null          // unknown: show nothing now, ask again next time
  }
  try { window.sessionStorage.setItem(CONFIG_KEY, JSON.stringify(memoryConfig)) } catch (_) { /* ignore */ }
  return memoryConfig
}

// Fire and forget. Only the fields below ever leave the browser: the event name, the visitor id, a tier, a yes/no.
export function trackHumanDemand(event, { tier, coverLetter } = {}) {
  const body = { event, visitorId: getVisitorId() }
  if (tier) body.tier = tier
  if (typeof coverLetter === 'boolean') body.coverLetter = coverLetter
  return api.post('/human-demand/events', body).catch(() => {})
}

export async function joinHumanWaitlist({ tier, coverLetter, consent, email }) {
  const body = { visitorId: getVisitorId(), tier, coverLetter: !!coverLetter, consent: !!consent }
  if (email) body.email = email
  const res = await api.post('/human-demand/waitlist', body)
  return res?.data?.data
}
