// Pure route -> title table (kept separate from the hook so it can be unit-tested
// without React). See hooks/usePageTitle.js.
import { HOME_TITLE, findPublicPage } from './publicPages'

export const DEFAULT_TITLE = HOME_TITLE

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
  [/^\/scan\/[^/]+\/why\/?$/i, 'Why this score'],
  [/^\/scan\/[^/]+\/resume\/?$/i, 'Your resume'],
  [/^\/scan\/[^/]+\/apply\/?$/i, 'Apply'],
  [/^\/scan\/./, 'Your scan'],
  [/^\/scan\/?$/, 'New scan'],
  [/^\/v\//, 'Resume verification'],   // neutral: Verify.jsx names the real state once it has loaded (a page can be unverified, revoked, removed…)
  [/^\/check/, 'Check a resume'],
  [/^\/dashboard\/settings/, 'Settings'],
  [/^\/dashboard\/proof/, 'Proof'],
  [/^\/dashboard\/story/, 'My Story'],
  [/^\/dashboard/, 'Your scans'],
  [/^\/human\/orders\/?$/, 'Your human rewrite orders'],
  [/^\/human\/order\/?$/, 'Order a human rewrite'],
  [/^\/human/, 'Human rewrite'],
  [/^\/expert/, 'Expert workbench'],
  [/^\/admin/, 'Admin'],
  [/^\/partner/, 'Partner'],
]

// ROUND-3 AUDIT FIX (bug): `v` was missing, so a candidate's verification page (first name + score)
// carried no noindex of its own — the only thing keeping it out of search was a header the
// link-preview Function adds, and only when its API call succeeded in time. public/_headers now
// sends X-Robots-Tag for /v/* too.
// Case-insensitive like the router, so "/Dashboard" is private too.
const PRIVATE = /^\/(scan|dashboard|admin|partner|payment|reset-password|verify-email|v|human|expert)(\/|$)/i

// A page listed in lib/publicPages.js (the search-index registry) names its own title there: the static <head> a crawler
// reads before any JavaScript runs and the tab title set here must be the same string, and a page added to the
// registry later (a blog post) needs no second edit in this file. Everything else falls through to the table above.
export function titleFor(pathname) {
  const page = findPublicPage(pathname)
  if (page) return page.title
  const hit = ROUTES.find(([re]) => re.test(pathname))
  return hit ? `${hit[1]} — Passthrough` : DEFAULT_TITLE
}

// A page in the search-index registry is public by definition. This matters for /partner/apply and /partner/terms: the
// /partner prefix above is private (token pages), and without this check the SPA stamped <meta name="robots"
// content="noindex,nofollow"> and removed the canonical on those two pages at runtime, while _headers, robots.txt and
// the sitemap all said "index me". Google reads the rendered page, so the noindex won.
export function isPrivatePath(pathname) {
  if (findPublicPage(pathname)) return false
  return PRIVATE.test(pathname)
}
