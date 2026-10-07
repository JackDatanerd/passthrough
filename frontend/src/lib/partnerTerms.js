// Payments & Pricing round 4, G6: how referral attribution works, stated once for every
// partner-facing page. Mirrors the real behaviour:
//  - hooks/useReferralCapture.js: a visitor's attribution lasts 30 days from their LAST click on
//    the partner's link (every click refreshes it);
//  - nothing limits it to a first purchase, so each purchase made inside that window earns
//    commission (and gets the code's discount);
//  - refunds reverse the commission (it nets against later payouts).
export const ATTRIBUTION_WINDOW_DAYS = 30

export const ATTRIBUTION_TERMS = [
  `A visitor is credited to you for ${ATTRIBUTION_WINDOW_DAYS} days after their most recent click on your link — each new click restarts the ${ATTRIBUTION_WINDOW_DAYS} days.`,
  'Every purchase they make in that window earns you commission, not just the first — including repeat purchases.',
  'If a purchase is refunded, its commission is reversed and nets against your future payouts.',
]
