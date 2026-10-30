# Audit pass 1: realm sign-in, second factor, sessions, password reset (A1)

Base `1e4b582`. Files read in full: `expert-realm-auth.controller.js`, `expertSession.service.js`, `expertRealm/config.js`, `expertRealm/crypto.js`, `middleware/expertRealm.js`, `expert-realm.routes.js`, `permissions.js` (registry only), `lib/totp.js`, `expertAudit.service.js`, `scripts/expert-staff-account.cjs`, the session, recovery and reset tables in migration 0127, `fieldCrypto.sealTaxId/openTaxId`. Read only in part: `lib/jwt.js` (first 80 lines; its own header says the no-`exp` and algorithm issues were fixed in an earlier audit), `middleware/rateLimiter.js` (`isBypassed`, the generic limiter).
Method: each suspected issue was reproduced with a real HTTP-level test against the 2A harness before it was called a finding. Baseline on the base: 74 realm tests passed.

## Fixed (each has a regression test that fails on the old code)

| # | Finding | Severity | Evidence before the fix | Fix |
|---|---|---|---|---|
| F1 | Lockout counter was read, +1, written back. Parallel wrong guesses all wrote the same value and never reached the lock. Applies to password, second factor, recovery code, step-up and change-password. | High (the lock is the only brute-force backstop when the rate limiter fails open, and per-session limits are bypassed by opening new sessions) | 12 parallel wrong passwords left `failed_logins` at 1, `locked_until` null | compare-and-set on the value read, retry on a lost race, lock if contention will not settle (`recordFailure`) |
| F2 | The "rotated" cookie after the second factor was the same token: same session id, same claims. The cookie from the password step became the full session. | Medium (HttpOnly and `__Host-` limit exposure, but the stated rotation was not real) | old pending cookie returned 200 on `/me` after sign-in; the two cookie strings were identical | `promoteSession`: new session row and cookie, pending row revoked (`promoted`); the audit row now names the new session |
| F3 | Step-up and change-password ignored the lock, so a stolen full-session cookie could guess the password with no lock (step-up is the control that protects money and unmasking). | Medium | wrong and right passwords both answered normally while `locked_until` was in the future | both refuse with 429 while locked |
| F4 | Sign-in told a locked account apart from a wrong password or unknown email (429 `LOCKED` vs 401), an account-existence oracle that anyone can trigger with five bad tries. | Low to medium | locked 429 / unknown 401 | one 401 body for all four cases (wrong password, unknown email, disabled, locked); the message says sign-in pauses after several failures |
| F5 | The second-factor "replay-proof" claim failed under concurrency: the used step was written after the check, so the same code sent twice at once signed in both sessions. | Low (needs the password and a live code) | parallel same code on two pending sessions: 200 and 200 | compare-and-set on `totp_last_step`; the loser is a failed code |
| F6 | A reset link whose account was deleted after the link was issued threw (500). | Low | status 500, `Cannot read properties of null` | clean 400 |

Existing test changed: one line in `tests/expertRealm.phase2a.test.js` (a locked sign-in now expects 401, not 429, because of F4). New tests: `tests/expertRealm.auditAuth1.test.js`, 8 tests; 7 fail on the old code, the eighth is a guard that held before too.

## Probed and NOT a finding
- A non-uuid in `DELETE /sessions/:id`: supabase-js returns an error object, and `revoke` ignores it and answers 200. No 500. (An attempted guard broke the test world and was removed.)

## Not fixed: reported for you or later passes
1. **First-sign-in enrolment is protected by the first password alone (decision for you).** Until an account finishes setup, whoever holds the printed first password can enrol their own authenticator and lock the real person out. The window is from account creation to first sign-in. Options: expire the first password after N hours if no second factor is set, or an enrolment link. Not built because it changes the onboarding procedure.
2. Lockout is a denial lever: five bad guesses lock a known address for the lock time. Inherent to account lockout; a per-IP-and-account counter would soften it.
3. Password-reset requests: a new request voids the earlier link (an attacker can keep voiding a real one), the only limit is 6 per hour per IP and it is shared with the reset call, and the answer time differs for existing accounts (they write a row and send mail).
4. `issueRecoveryCodes` deletes the old codes and then inserts; a failed insert leaves the account with none (reissue needs an elevated session, so it can be redone).
5. `TAX_ID_ENCRYPTION_KEY` seals partner tax ids, locked resume values and second-factor secrets with one key and no context binding; `openTaxId` accepts a plain-text value. A leaked key or a database write is then worse than it needs to be. Fix is a shared-library change (flag before making).
6. The gate prefers the `Host` header over the request URL's host. Cloudflare routes by host, so this looks safe, but `new URL(c.req.url).host` is the stricter source. Unverified on the live Worker.
7. Audit rows for sign-in, failed codes and denied attempts are written fail-open (only job content and money fail closed, as designed). A database outage would hide failed-login evidence.
8. Pending sessions that never finish accumulate in `expert_sessions`; I did not check that anything purges them.
9. `revokeAll` bumps `token_version` by read-then-write; two simultaneous calls can bump once. Sessions are all revoked anyway, so no effect today.

## Could not test from here
A real browser and cookie handling on the live host; a phone authenticator; the real Postgres (the harness is an in-memory fake, so F1 and F5 are proven for the code's read/write shape, not against concurrent real connections: re-test on a staging database); the rate limiter's atomicity (shared code, not audited here); email delivery; the full `jwt.js` verify path.
