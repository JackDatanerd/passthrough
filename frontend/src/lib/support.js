// The one place the support address is decided for everything the visitor reads (support-inboxes round 1).
// It used to be typed into a dozen pages; the Worker side has the same single source in src/lib/supportEmail.js.
// To change it: set SUPPORT_EMAIL on the Worker and VITE_SUPPORT_EMAIL for the frontend build (or edit DEFAULT below).
// A blank or malformed override falls back to the default — a bad build variable must never put garbage in a mailto link.
const DEFAULT_SUPPORT_EMAIL = 'support@usepassthrough.com'
const override = String((typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_SUPPORT_EMAIL) || '').trim()

export const SUPPORT_EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(override) ? override : DEFAULT_SUPPORT_EMAIL
export const SUPPORT_MAILTO = `mailto:${SUPPORT_EMAIL}`
