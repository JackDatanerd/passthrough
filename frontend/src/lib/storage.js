// localStorage that cannot take the app down.
//
// BUG FIX (Auth round 3, B5): AuthProvider, the API client, the route guards and
// several pages read/wrote localStorage directly. Browsers with storage blocked
// ("block all cookies", some in-app browsers, sandboxed iframes) throw a
// SecurityError on the very first access — inside AuthProvider's initial render,
// that white-screened the whole app before any page could show a message.
//
// Every access is guarded. When storage is unavailable the value is kept in
// memory for the life of the page, so signing in still works for this visit
// (the token is just not remembered across reloads or shared between tabs).

import { TOKEN_KEY, USER_KEY } from './session'

const memory = new Map()

export function storageGet(key) {
  // Memory first: a value lands there only when localStorage.setItem threw (quota exceeded, some
  // private modes) — and in those browsers getItem often still WORKS, answering null/stale. Reading
  // storage first made a token that had just been "saved" read back as absent, so sign-in looked
  // successful and the person was effectively signed out (and every request minted a new device id).
  // storageSet clears the memory copy whenever a real write succeeds and storageRemove always
  // clears it, so a memory entry is never older than storage.
  if (memory.has(key)) return memory.get(key)
  try { return localStorage.getItem(key) }
  catch (_) { return null }
}

export function storageSet(key, value) {
  try { localStorage.setItem(key, value); memory.delete(key); return true }
  catch (_) { memory.set(key, String(value)); return false }
}

export function storageRemove(key) {
  memory.delete(key)
  try { localStorage.removeItem(key) } catch (_) { /* storage unavailable */ }
}

export const getToken = () => storageGet(TOKEN_KEY)
export const setToken = token => storageSet(TOKEN_KEY, token)

// The cached user object, or null when absent / unreadable.
export function getCachedUser() {
  try { return JSON.parse(storageGet(USER_KEY)) } catch (_) { return null }
}
export const setCachedUser = user => storageSet(USER_KEY, JSON.stringify(user))

// A random id that identifies THIS browser to the API, sent as `X-Device-Id`. It is not a credential and
// carries no personal data: its only job is to let the anonymous free scan be allowed per device instead
// of per IP address, which on mobile carriers (many unrelated people behind one address) meant one
// visitor per hour got the scan and everyone else was refused. The API caps rotating ids per IP, so
// clearing storage buys nothing. When storage is unavailable the id lives in memory for the page.
const DEVICE_KEY = 'pt_device_id'
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function newDeviceId() {
  try { if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID() } catch (_) { /* fall through */ }
  const hex = n => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(Math.random() * 4)]}${hex(3)}-${hex(12)}`
}

export function getDeviceId() {
  const existing = storageGet(DEVICE_KEY)
  if (existing && UUID_V4.test(existing)) return existing
  const id = newDeviceId()
  storageSet(DEVICE_KEY, id)
  return id
}
