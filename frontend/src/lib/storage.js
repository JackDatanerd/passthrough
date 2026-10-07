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
  try { return localStorage.getItem(key) }
  catch (_) { return memory.has(key) ? memory.get(key) : null }
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
