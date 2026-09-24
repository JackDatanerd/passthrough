// Pure route -> title table (kept separate from the hook so it can be unit-tested
// without React). See hooks/usePageTitle.js.
export const DEFAULT_TITLE = 'Passthrough — Does your resume pass the ATS filter?'

const ROUTES = [
  [/^\/pricing/, 'Pricing'],
  [/^\/login/, 'Sign in'],
  [/^\/register/, 'Create account'],
  [/^\/forgot-password/, 'Reset password'],
  [/^\/reset-password/, 'Set a new password'],
  [/^\/verify-email/, 'Verify your email'],
  [/^\/terms/, 'Terms of Service'],
  [/^\/privacy/, 'Privacy Policy'],
  [/^\/payment\/success/, 'Payment'],
  [/^\/scan\//, 'Your scan'],
  [/^\/v\//, 'Verified resume'],
  [/^\/check/, 'Check a resume'],
  [/^\/dashboard\/settings/, 'Settings'],
  [/^\/dashboard/, 'Your scans'],
  [/^\/admin/, 'Admin'],
  [/^\/partner/, 'Partner'],
]

// ROUND-3 AUDIT FIX (bug): `v` was missing, so a candidate's verification page (first name + score)
// carried no noindex of its own — the only thing keeping it out of search was a header the
// link-preview Function adds, and only when its API call succeeded in time. public/_headers now
// sends X-Robots-Tag for /v/* too.
const PRIVATE = /^\/(scan|dashboard|admin|partner|payment|reset-password|verify-email|v)(\/|$)/

export function titleFor(pathname) {
  const hit = ROUTES.find(([re]) => re.test(pathname))
  return hit ? `${hit[1]} — Passthrough` : DEFAULT_TITLE
}

export function isPrivatePath(pathname) {
  return PRIVATE.test(pathname)
}

