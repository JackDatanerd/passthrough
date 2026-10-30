# A2: realm pipeline and permission matrix: audit pass 1 (base `9e79fa1`)

Files read in full: `middleware/expertRealm.js`, `lib/expertRealm/{permissions,config,stateMachine,clock}.js`, `routes/expert-realm.routes.js`, `controllers/expert-realm.controller.js`, `controllers/expert-admin.controller.js`, `src/index.js` (mount order and global middleware), `middleware/{cors,securityHeaders,bodyLimit,optionalAuth}.js`, `services/{expertSession,expertAudit,expertBridge,humanJobs}.service.js`, migration 0127 (`human_job_transition`, `expert_bridge_calls`). Every finding below was reproduced with a probe test before it was fixed.

## Feature gaps closed
| # | Gap | Now |
|---|---|---|
| G1 | The Worker route `experts.usepassthrough.com/api/*` put the whole main API (admin, auth, payments, webhook, Phase 1 expert) on the expert host; the realm refused other hosts but nothing refused the main app on the expert host | `middleware/expertHostGuard.js`, mounted first in `index.js`: with `EXPERT_SITE_URL` set, the expert host answers only under `/api/expert-realm` and `/api/expert-admin`; everything else is the ordinary 404. Inert while the setting is unset |
| G2 | The registry only recorded a policy; the middleware a route ran was written by hand beside it. Nothing compared the routers' real route tables to it | `define()` now adds the guards (session stage, per-account limiter, matrix check) from the policy; refuses no handler, unknown auth, a divergent duplicate; a test compares both routers' served routes to the registry |
| G3 | `grant.scope` and `reason` were set and never read; ownership was hand-written per controller; the matrix said Y for admin/support on `job.view_full` while the controller refused them | `lib/expertRealm/scope.js` `jobAccess()` is the one ownership rule (own / any, content never on any); `jobBrief` uses it; the matrix comment says what Y means |
| G4 | Board had no paging; assign/reassign had no version check though the console shows `version` | `board?before=` with `nextBefore`; `expectedVersion` on assign and reassign goes to the engine (409 `VERSION_CONFLICT`) |

## Bugs fixed
| # | Bug | Fix |
|---|---|---|
| B1 | Refund key reused on a different job answered `queued, replay` (200) and queued nothing; audit said queued | A replay only counts for the same job and amount; otherwise 409 `KEY_REUSED`. No migration needed |
| B2 | A refund key left at `started`, or refused earlier, answered 200 `Not possible: null` | 409 `UNFINISHED` / the earlier code; a refusal is never a 200 |
| B3 | Denied requests and brief reads wrote audit rows with no limit (60 requests, 60 rows) | A per-account limiter runs before the matrix check on every action route (`rl:xr:adm` console, `rl:xr:own` desk and brief) |
| B4 | A database error on the brief's job lookup was a 403 `NO_ACCESS` plus a denied-read audit row | 503, no denial row |
| B5 | Job detail swallowed read errors: empty timeline and a false clock mismatch, or a 404 | 503 on any failed read; `eventsTruncated` and a null clock check when the 2000-event cap is hit |
| B6 | `EXPERT_SITE_URL` with capitals or `:443` made every write 403 `BAD_ORIGIN` silently | `siteOrigin` goes through `new URL().origin`; a non-URL gives null (the realm refuses to run) |
| B7 | An oversized body in `requireAction` read as "reason required" | The 413 is passed up |
| B8 | Directory load counted from the default 1000-row cap; event cap 500 dropped the newest events | Cap 20000; cap 2000 with a truncation flag |

## Decisions and notes
- Admin and support still never receive job content in 2A. The matrix Y means state, timeline and money through the console.
- The refund replay check needed no schema change; the unique index stays `(fn, idem_key)`. A stale `started` row is resolved by using a new key after checking the payment (the message says so). Whether `queueRefund` itself is safe to re-run is A7.
- Self-assignment (an account holding both `expert` and `expert_admin` assigning to itself) is allowed by the engine. It is a product decision, not changed here; flagged for A4/A9.

## Not tested
The deployed Worker route and live database; the real Paystack refund path; two real browsers at once. Everything ran on the in-memory fake.

## Status
Pass 1 fixed and tested. A2 is closed only when an independent pass 2 finds nothing.
