// A one-shot message that survives a hard navigation (window.location.replace) — the API client
// redirects with a full page load, which wipes React state, so "why was I sent here?" has nowhere
// to live except storage. Written by the sender, read ONCE by the destination (consumeFlash clears it).
// sessionStorage is per-tab, so another tab never shows someone else's notice; every access is
// guarded, and an in-memory copy covers browsers with storage blocked (same-page only).

const FLASH_KEY = 'pt_flash'
let memoryFlash = null

export const FLASH_ADMIN_DENIED = 'admin-denied'

export function setFlash(code) {
  memoryFlash = code
  try { sessionStorage.setItem(FLASH_KEY, code) } catch (_) { /* storage unavailable */ }
}

// Reads the flash WITHOUT clearing it. A component that shows the notice reads it with this during
// render and clears it from an effect: consuming inside a render-phase initializer is a side effect,
// and StrictMode (on in main.jsx) runs initializers twice in development, so the second run found it
// already gone and the notice never appeared under `npm run dev`.
export function peekFlash() {
  let code = null
  try { code = sessionStorage.getItem(FLASH_KEY) } catch (_) { /* storage unavailable */ }
  return code || memoryFlash || null
}

export function consumeFlash() {
  let code = null
  try {
    code = sessionStorage.getItem(FLASH_KEY)
    sessionStorage.removeItem(FLASH_KEY)
  } catch (_) { /* storage unavailable */ }
  if (!code) code = memoryFlash
  memoryFlash = null
  return code || null
}

const MESSAGES = {
  [FLASH_ADMIN_DENIED]: "That page is for administrators — your account doesn't have admin access.",
}

export function flashMessage(code) {
  return MESSAGES[code] || null
}
