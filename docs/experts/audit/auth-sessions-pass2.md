# Audit pass 2: realm sign-in and sessions (A1), the nine reported items

Follows `auth-sessions-pass1.md` (same section, same base `1e4b582`). Same method: each item gets a test, and the tests were run against the code before this pass: 10 of the 11 new tests fail there (the exception is the first item-4 test, which checks the end state that the old delete-then-insert also reached; the second item-4 test, which simulates a failed insert, is the one that fails on the old code). Item numbers follow the "Not fixed" list in pass 1.

| # | Item | Result | What changed |
|---|---|---|---|
| 1 | First sign-in enrolled by first password alone | **fixed (default chosen, see below)** | a first password stops working after `enrol_hours` (default 72, setting 1 to 720) while the account has no second factor; same 401 answer as any refusal; audit row `auth.enrolment_expired`; `scripts/expert-staff-account.cjs --reissue --email x` prints the SQL for a new first password (only touches an account with no second factor, restarts the clock) |
| 2 | Lockout can be used to lock someone out | **accepted, not changed** | inherent to lockout. Already in place: 15-minute lock, a password reset clears it (needs the person's email), every lock is audited, lock refusals no longer reveal the account (F4). A per-IP counter or an admin unlock button would be a new feature; say if you want it in A2 |
| 3 | Reset requests | **fixed** | answer sent first and the work runs after it (`waitUntil`), so timing no longer differs; at most 3 links per account per hour (extra requests look identical and do nothing); a new request no longer voids earlier links; a used link voids all others; forgot has its own rate bucket |
| 4 | Recovery-code reissue not atomic | **fixed** | new set stored first, old ids deleted after; a failed insert leaves the old set working |
| 5 | One key for tax ids, locked values and second-factor secrets | **partly fixed, rest needs your decision** | realm side: a value in `totp_secret_enc` that is not sealed is never used. NOT done: key separation and context binding. They change the stored format, and the Phase 1 pilot sign-in (`expert-auth.controller.js`) reads the same column with the old reader, so a re-sealed secret would lock pilot experts out. Needs a change to the Phase 1 reader at the same time, or a new column. Planned for A9 |
| 6 | Gate trusted the Host header first | **fixed** | the host comes from the request URL only |
| 7 | Audit writes fail open | **fixed for sign-in, logged for the rest** | a sign-in that cannot be recorded is refused (503) and its new session is ended before any cookie is set. Failed-attempt and denied rows stay non-blocking by design (an audit outage must not become a login outage), but every failed write now logs a line (`[AUDIT] ...`). Password change, reset and revoke-all rows are also non-blocking: the action has already happened when the row is written |
| 8 | Unfinished sessions pile up | **fixed** | at each sign-in, that expert's expired pending sessions and anything expired over 30 days ago are deleted (best effort) |
| 9 | `token_version` read-then-write | **fixed** | compare-and-set loop |

## Decision I made for you (item 1)
Default of 72 hours, as a setting. **Existing accounts with no second factor that are older than 72 hours are refused until re-issued** (including any Phase 1 pilot expert created but never signed in). Re-issue with the script. The clock is `created_at`, so a re-issued account's created date in the directory moves to the re-issue date; there is no migration. If you want a real column or a different rule (an enrolment link), say so.

## Existing files touched (this pass)
`src/controllers/expert-realm-auth.controller.js`, `src/services/expertSession.service.js`, `src/services/expertAudit.service.js` (one log line), `src/middleware/expertRealm.js` (host source, new `forgotIp` limiter), `src/routes/expert-realm.routes.js` (forgot uses it), `src/lib/expertRealm/config.js` (`enrol_hours`), `scripts/expert-staff-account.cjs` (`--reissue`), `docs/experts/phase2a/staff-accounts.md`. Tests: one stub line (`isSealed`) added to the harness in `expertRealm.phase2a.test.js` and `expertRealm.auditAuth1.test.js`; one test added to `tests/expertStaffScript.test.js`. No migration; `EXPECTED_SCHEMA_VERSION` unchanged. Flag off: unchanged (flag-off snapshot and cross-realm tests pass).

## Things to know
- Item 3 relies on `waitUntil` in production; with no execution context the work is awaited (timing differs again, nothing breaks).
- A person who requests 3 links and loses all 3 emails waits up to an hour.
- Item 7 means a problem with the audit table alone now blocks sign-in (503). Intended.
- Not tested: real Postgres concurrency (item 9, F1, F5 are proven on the in-memory double only), `waitUntil` on the real Worker, a browser, email delivery, the rate limiter's atomicity, the full `jwt.js` verify path.
