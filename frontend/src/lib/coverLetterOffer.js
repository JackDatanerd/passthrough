// How the cover-letter feature is described on every selling surface (offer card, pricing page, home pricing section).
// The per-tier allowance is the Worker's COVER_LETTER_LIMITS, served on /api/pricing as `coverLetterLimits`; the defaults
// below only cover a response from before the field existed, so the page never shows a number the Worker did not send.
export const DEFAULT_COVER_LETTER_LIMITS = { BADGE: 2, FIX_PLAIN: 3, FIX: 5 }

export function coverLetterLimit(pricing, tier) {
  const n = pricing?.coverLetterLimits?.[tier]
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_COVER_LETTER_LIMITS[tier]
}

// "Cover letter writing: 5 tailored letters" (the NEW tag is drawn by <NewTag/> beside it).
export function coverLetterText(pricing, tier) {
  const n = coverLetterLimit(pricing, tier)
  return `Cover letter writing: ${n} tailored ${n === 1 ? 'letter' : 'letters'}`
}
