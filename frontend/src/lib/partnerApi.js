// Partner pages are identified by a bearer token from their emailed link (no login).
// The token is sent in a header, NOT the query string: query strings are written into
// request logs (the API Worker's observability samples every request), and the payout
// token can redirect real money. The page URL still carries ?token= — that is the link
// the partner was emailed — but it never reaches an API URL. The API also still accepts
// ?token= so links and cached bundles from before this change keep working.
export const PARTNER_TOKEN_HEADER = 'X-Partner-Token'

export function partnerAuth(token, extra = {}) {
  return { headers: { [PARTNER_TOKEN_HEADER]: String(token || '') }, ...extra }
}
