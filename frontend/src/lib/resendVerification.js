// POST /auth/resend-verification answers 400 "Already verified." when the account was verified
// meanwhile (another device or tab). That is not a failure to show: the cached user is simply stale
// and needs re-syncing so the "verify your email" prompts go away.
export function isAlreadyVerified(err) {
  return err?.response?.status === 400 && /already verified/i.test(String(err.response?.data?.message || ''))
}
