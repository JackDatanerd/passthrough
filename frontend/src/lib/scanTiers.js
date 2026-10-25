// What each purchased tier DOES, in one place: the strip, the headings, the banners and the offer all read it, so a Verified-only
// delivery is never described as a rewrite and a plain fix is never promised a credential.
//   FIX        rewrites the resume AND issues the credential when the delivered file clears the bar
//   FIX_PLAIN  rewrites the resume, no credential
//   BADGE      rewrites nothing; formats the existing content and issues the credential when the delivered file clears the bar
import { ATS_BADGE_THRESHOLD } from './scoreThresholds'

export const rewrites = tier => tier !== 'BADGE'
export const mayEarnCredential = tier => tier !== 'FIX_PLAIN'

// The steps of the passage a person sees on the pinned strip, in order.
export function passageSteps(tier) {
  if (tier === 'BADGE') return ['scanned', 'verified']
  if (tier === 'FIX_PLAIN') return ['scanned', 'rewritten']
  return ['scanned', 'rewritten', 'verified']
}

// Was the credential actually earned? (the delivered file's own score, not the scan's)
export const credentialEarned = scan => typeof scan?.fixAtsScore === 'number' && scan.fixAtsScore >= ATS_BADGE_THRESHOLD

// The plan an offer should lead with. Over the credential bar (with the file we would deliver confirmed to clear it too) nothing
// needs rewriting, so the cheapest plan that does the job leads and the rewrite is the step up. Everywhere else the full fix leads.
// `eligible`: scan scored >= the credential bar. `badgeSafe`: the credential-only file is known to clear the bar as well.
export function recommendPlan({ eligible, badgeSafe, provisional = false }) {
  if (eligible && badgeSafe && !provisional) return { primary: 'BADGE', alts: ['FIX', 'FIX_PLAIN'] }
  return { primary: 'FIX', alts: ['FIX_PLAIN'] }
}
