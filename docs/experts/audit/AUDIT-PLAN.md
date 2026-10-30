# Experts: audit plan (Phases 0A, 1 and 2A)

Nothing in Experts had an independent audit before pass 1 (30 Oct 2026, base `1e4b582`). Phase 2B is on hold until the sections marked **before 2B** are done.
One section per chat. Each pass: read the section's files in full, probe suspected findings with real tests (not by reading alone), fix what is confirmed, add regression tests that fail on the old code, list what was not fixed and why, list what could not be tested. Fixes are additive where possible; anything that changes shared files or a spec decision is flagged first.

## What exists (as read from the repo)

| Phase | State | Where |
|---|---|---|
| 0A demand test | committed, flag `HUMAN_DEMAND_ENABLED` | `src/controllers/human-demand.controller.js`, `src/lib/humanDemand.js`, migration 0119, `HumanRewriteOption.jsx` |
| 0B groundwork | drafts only (docs) | `docs/experts/phase0/` (not code, not audited here) |
| 1 concierge pilot | built, flag `EXPERTS_ENABLED`, not deployed | migration 0124 (657 lines, 11 tables, 19 functions), `human*.js`, `expert*.js` (Phase 1 expert auth), `admin-human.controller.js`, frontend `pages/human`, `pages/expert`, `pages/admin/AdminHumanOrders.jsx` |
| 2A realm and job engine | built, flag `EXPERT_REALM_ENABLED`, not deployed | migration 0127 (388 lines), `src/lib/expertRealm/*`, `middleware/expertRealm.js`, `expert-realm*.controller.js`, `expert-admin.controller.js`, `expertSession/Audit/Bridge.service.js`, `frontend/src/experts/*` |
| 2B workbench, gate, delivery | not started (needs audited 2A) | |

## Sections

Order is by risk (money, content access, identity first).

| # | Section | Main files | Why this order | Status |
|---|---|---|---|---|
| A1 | Realm sign-in, second factor, sessions, password reset | `expert-realm-auth.controller.js`, `expertSession.service.js`, `expertRealm/{config,crypto}.js`, `lib/totp.js` | identity; everything else trusts it | **passes 1 and 2 done** (`auth-sessions-pass1.md`, `auth-sessions-pass2.md`; key separation for second-factor secrets deferred to A9) |
| A2 | Realm pipeline and permission matrix: gate, CSRF, `requireAction`, route registry, host routing, flag-off snapshot, cross-realm | `middleware/expertRealm.js`, `permissions.js`, `expert-realm.routes.js`, `src/index.js` mounting, `expert-realm.controller.js`, `expert-admin.controller.js` | **before 2B**; every 2B route uses it | **pass 1 done** (`a2-pass1.md`); pass 2 (independent) to do |
| A3 | Phase 1 database layer, part 1: content access (`human_job_expert_read/save/baseline`, assignment, grants, `security definer`, search_path, locked-value storage) | migration 0124 (content functions), `humanLocks.js` | **before 2B**; an expert reads client content only here | **pass 1 done** (`content-access-pass1.md`; migration 0128) |
| A4 | State machine and job engine: transitions, pauses, next actions, idempotency keys, the Phase 1 vs 2A divergence (2A known gap 1) | `stateMachine.js`, `clock.js`, migration 0127 functions | **before 2B**; delivery and revision ride on it | |
| A5 | Locking, masking, diff, fact check, files | `humanLocks/Diff/Facts/Pilot.js`, `expert.controller.js`, `human-files.controller.js` | what the expert can see; 2B extends all of it | |
| A6 | Phase 1 database layer, part 2: money (confirm payment, accept, reverse, payout, earnings, uniqueness guards) | migration 0124 (money functions), `humanSettle.js`, `fulfillment.service.js` hooks | money moves only here | |
| A7 | Audit log, bridge, refund path, admin console actions | `expertAudit/Bridge.service.js`, `expert-admin.controller.js` refund, `reversePayment` hook | step-up and reasons; refund is the one money action in 2A | |
| A8 | Customer order flow: checkout, settle, sweep, delivery, retention, deletion, emails | `human.controller.js`, `humanSweep.js`, `humanDelivery.service.js`, `humanJobs.service.js` | | |
| A9 | Phase 1 admin screens and expert accounts and payouts | `admin-human.controller.js`, `expert-auth.controller.js`, `expertAuth.js`, `AdminHumanOrders.jsx` | | |
| A10 | Migrations and schema consistency: numbering (0125 records itself as 124), ledger, `EXPECTED_SCHEMA_VERSION`, RLS and revokes across 0119, 0124, 0127, rollback script | `supabase/migrations/*`, `migrationLedger.js` | cheap, catches deploy failures | |
| A11 | Frontend and expert site build: headers, redirects, CSP, API clients, customer pages, tracker, build isolation | `frontend/src/experts/*`, `public-experts/*`, `pages/human`, `pages/expert` | | |
| A12 | Demand test (0A) | `human-demand.*`, migration 0119 | low risk, no money, no content | |

Before 2B: A1 to A4, plus A5 and A6 because 2B extends them. Suggested next chat: **A2**.

## How to run a pass

Open a chat with: the section number, "audit pass, base = current HEAD", and the repo public. The chat clones, installs, runs the section's tests, reads the files, probes, fixes, and delivers a patch plus tarball with the git commands.
