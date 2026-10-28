# Passthrough Experts: build status

Contract: `passthrough-experts-spec-pack-index.docx` (read first), `passthrough-experts-spec-v2.2.docx` (product intent), `passthrough-experts-engineering-spec-v1.1.docx` (technical detail). The existing code wins over any description of it.

## Base

- Phase 0B (non-code groundwork) was built on commit `59f6d4a` (26 Oct 2026, 22:20 +03:00, "Scan/ATS: stop foreign stop words ..."). The files read for Phase 0B tasks 4 and 9 were read at `4f261ac`; the only change between `4f261ac` and `59f6d4a` is the ATS service, its test and a CHANGES file, none of which Phase 0B reads.
- Phase 0A was built on commit `ae07e09` (26 Oct 2026, 13:34 +03:00, "Partners round 41 ...") and is committed as `4f261ac`.
- Earlier drafts were checked against `7388d37` and `38817f2` (24 Oct). Between `7388d37` and `ae07e09` no file this work touches or depends on changed.
- **Phase 1 (concierge pilot) was built on commit `%s`** (28 Oct 2026, 06:44 +03:00, "Partners section 4 round 43 ..."), after four earlier re-clones as the repo moved (bases `6473c79`, `6c2aa26`, `0ba3616`, `491c7f5`). Next free migration at that time: **0124** (files and ledger stood at 123; `EXPECTED_SCHEMA_VERSION` 123).
- Next free migration at the Phase 0A time: **0119** (files, ledger and `EXPECTED_SCHEMA_VERSION` all stood at 118).

## Phases

| Phase | Name | State |
|---|---|---|
| 0 | Demand test and groundwork | **0A (demand test code) committed as `4f261ac`; deployment not confirmed.** **0B (non-code groundwork) delivered as drafts in `docs/experts/phase0/`; most items still need the owner or counsel (checklist below).** |
| 1 | Concierge pilot | **Built, behind a flag (off), not deployed. Gate = the pilot's results (section 22), which only the owner can produce.** See "Phase 1" below. |
| 2 | MVP platform, invite only | not started |
| 3 | Marketplace mechanics | not started |
| 4 | Grades and quality | not started |
| 5 | Payouts and onboarding | not started |
| 6 | Trust, disputes and support | not started |
| 7 | Hardening and independent audits | not started |
| 8 | Controlled launch and growth | not started |

## Phase 0A: what exists

A fake door for **Human rewrite**, behind one flag, waitlist only. No payment, no deposit, no job table, no expert realm.

- Flag: Worker variable `HUMAN_DEMAND_ENABLED`; on only for the exact string `true`. Unset = off. While off, `/api/human-demand/*` answers the app's ordinary 404 and the offer card renders nothing extra.
- Offer card (`FixBanner.jsx`): a small secondary block "Want a person to do it?" with a **Human rewrite** button, placed under the AI Fix and "Fix only" lines. It never replaces the AI Fix.
- Modal: honest copy (opening soon, not available yet, joining is free, no payment is taken, prices are the expected launch price), the four-rung ladder (Human polish; Human rewrite 7-day, 48-hour, 24-hour), a cover letter add-on, the privacy line, no preselected tier, no "most popular", no countdown.
- Price variants (product spec 16.1), US dollars:

| Variant | Polish | 7-day | 48-hour | 24-hour | Cover letter |
|---|---|---|---|---|---|
| low (bottom of test range) | $49 | $79 | $99 | $129 | +$25 |
| base (suggested start) | $59 | $89 | $119 | $149 | +$29 |
| high (top of test range) | $69 | $99 | $139 | $179 | +$39 |

- Assignment: the server hashes a random visitor id held in the browser's local storage (`pt_hd_vid`) with the salt in `src/lib/humanDemand.js`. Same browser, same variant, every visit. The browser never sends a variant or a price; the server derives both.
- Events (`human_demand_events`): `button_shown`, `button_clicked`, `tier_selected`, `cover_letter_toggled`, `modal_dismissed` from the browser; `waitlist_submitted` is written by the server only when a new waitlist row is created. Columns are only: event, visitor id, price variant, tier, cover letter yes/no, time. No free text is accepted (unknown keys are rejected).
- Waitlist (`human_demand_waitlist`): one row per person and tier. A signed-in person is stored by user id only (the account email is not copied, so erasing the account erases the contact detail). A visitor without an account gives an email (lower-cased) and must tick the email box. Also stored: cover letter interest, price variant, the quoted tier and cover letter price, contact consent, visitor id.
- Results: `docs/experts/phase-0a-results.sql` (seven read-only queries, run in the tests against real Postgres). No admin screen and no CSV route.
- Rate limits (per IP): config 60 per 10 minutes, events 120 per hour, waitlist 10 per hour. Fail open if the limiter backend is down, as the existing limiters do.

## Decisions made

1. **Two tables despite the engineering spec.** Engineering spec section 19 lists no migrations and "events only" for Phase 0. The owner's Phase 0A brief names two tables (events, waitlist), and a waitlist cannot be held without one. Followed the brief. Names are `human_demand_events` and `human_demand_waitlist` so they cannot be confused with the spec's Phase 1 `job_events` / `human_jobs`.
2. **Variants:** low and high are the ends of each test range in the 16.1 table; base is the suggested start. Prices are held in code (`src/lib/humanDemand.js`), in cents.
3. **One flag, read on the server.** The offer card asks `GET /api/human-demand/config` once per tab session and remembers the answer, including "off". Consequence: with the flag off, each tab session makes one request that answers 404, and that request counts toward the general per-IP limit. Nothing else changes. The alternative (also gating on a frontend build variable) was not taken, to keep a single switch that needs no redeploy of the site.
4. **Waitlist identity:** signed-in = user id; no account = email. One row per (person, tier); re-joining the same tier keeps the first quote and only refreshes cover letter interest and consent.
5. **Consent:** the "Email me when it opens" box starts unticked. Required for a visitor without an account; optional for a signed-in person (the record then says `contact_consent = false`).
6. **Privacy line:** section 6.1 gives a block of lines, not one sentence. The line used is: "A human expert will see your resume; your contact details stay hidden while they work."
7. **Events list:** engineering spec 16 refers to an event catalogue "in the design specification". None exists in the pack; the six events in the owner's brief were used.
8. **Waitlist button wording and placement** follow the owner's brief ("Human rewrite", secondary, beside the AI Fix). Prices shown are US dollars.
9. **Migration is additive only**: two `create table`, their indexes, row level security on with no policy, `revoke all` from anon/authenticated, the ledger row and the `schema_version` upsert. No function is added, so there is nothing to revoke execute on.


## Phase 1: plan (written before building)

**Goal.** A small, hand-picked group of experts serves real paid orders, with a human dispatching, so the owner learns price, quality, on-time delivery and margin before the marketplace is built.

**Built (all behind `EXPERTS_ENABLED`, off by default):**
1. A human product kind in the existing checkout path: a payment row with `product_kind` and **no scan**, a job created at checkout in `awaiting_payment` with the brief, frozen documents and a unique payment id; it moves to `offered` on confirmed payment, once. Prices and pay come from the settings row, never code.
2. The human line skips the whole code path (no code, usage slot, attribution, commission, welcome code or promo price). The human order code imports none of it, and a test proves it with every code type and the promo window active.
3. The brief form with supporting materials (6.3), the 18+ tick, third-party rights tick and optional improvement consent (6.2), using the Phase 0 wording.
4. Admin inbox inside the existing admin area: list, filter by state, view the brief, assign by hand, review, deliver, record minutes and costs, refund, accept, expert accounts, manual payouts, the pilot summary.
5. **Expert accounts: the minimum.** Hand-created by the operator (temporary password shown once), password plus authenticator-app code, a separate token secret, no self-registration. Pilot workbench: structured editor, locked contact fields and read-only anchors enforced **on the server**, up to three questions, submit for review.
6. Pilot recording fields on the job (active minutes, questions, revision, time to delivery, score before and after, rating, cost), job events, the operator's review of every delivery (Appendix F.3), client emails (order received, question, delivered; a refund uses the existing refund email), one revision round, the 72-hour acceptance rule and earnings written once on acceptance, retention and deletion of job files, and an audit row for every expert or staff view of client content.

**FLAG (needs the owner), where the plan goes beyond or differs from the specs:**
- The engineering spec puts expert two-factor columns, sessions and the expert realm in Phase 2. The pilot needs the **minimum** of them: two-factor on `expert_accounts`, stateless tokens revoked by a token version, **no `expert_sessions` table, no recovery codes** (the operator resets two-factor by hand), no idle timeout. Phase 2 replaces this.
- Expert pages are a lazy chunk of the existing frontend with their own API client and storage key, not a separate site (engineering spec 2.3 splits them in Phase 2).
- The brief says "settings table"; the app has none, so the settings are one row of `system_state` (key `human_pilot`), the same table the promo config uses.
- Polish has no turnaround in either spec, so it is built but **switched off** in the settings.

**Out (not built):** claim queue, offer cascade, strikes, grades, graders, payout automation, applications and the paid test flow, disputes console, the assistant, public explainer pages, marketplace settings UI, `expert_sessions`, recovery codes, a late-credit tool (the credit is recorded, not issued).

**Decision rule used.** If the editor spike passes, build the structured document path; if not, the operator-redaction fallback. If the realm spike fails, stop. **Both spikes passed, so the structured path was built.**

## Phase 1: spikes (code under `docs/experts/spikes/`, throwaway)

| Spike | Pass criteria (product spec 22.4) | Result |
|---|---|---|
| Editor: lock fields, track changes, render both files (`editor-spike.cjs`, results in `editor-spike-results.json`) | Locked values round-trip exactly; the diff matches a manual check; Word and PDF both render | **PASS** on three resumes, 10 checks each: the masked body holds no contact value; restore(lock(x)) equals x; the expert's edit is accepted; all 8 violations (change email, employer, dates; type an email, a phone, a web address; drop a job; remove the name) are refused; the diff paths equal the manual list; Word (LibreOffice render) and PDF (wkhtmltopdf, read back by OCR) contain the restored values and no marker. |
| Realm and token coexistence (`realm-spike.cjs`, results in `realm-spike-results.json`) | Cross-realm tokens rejected; no change to the existing admin tests | **PASS**: expert tokens fail the main auth middleware (and so the admin area) and main tokens fail the expert middleware, on signature alone; a shared or short secret refuses to run; **no existing admin or auth test file was changed**, and the pilot adds **no** failure to them (the existing failures in that set also fail on the untouched base). |

**Limits of the spikes (say so before you rely on them):** the three resumes are **synthetic** (no real customer resume is available here); the PDF came from the app's own resume HTML through wkhtmltopdf, **not Cloudflare Browser Rendering**, so it proves the HTML is complete and prints, not that Cloudflare's renderer matches; the Word file was checked in LibreOffice, not Microsoft Word.

## Phase 1: what exists

- **Flag:** Worker variable `EXPERTS_ENABLED`, on only for the exact string `true`. While off, `/api/human/*`, `/api/expert/*` and `/api/admin/human/*` answer the app's ordinary 404, the hourly sweep step does nothing, and the offer card is unchanged (the new link also needs the **build-time** variable `VITE_EXPERTS_ENABLED=true`, so with it unset the page makes no extra request at all).
- **Who may order:** `EXPERTS_ALLOWED_EMAILS` (comma list of account emails, or `*`). Unset = nobody.
- **Expert realm secrets:** `EXPERT_JWT_SECRET` (at least 32 characters, **different from** `JWT_SECRET`; otherwise expert sign-in answers 503). `TAX_ID_ENCRYPTION_KEY` must be set (the locked values and the two-factor secrets are sealed with it).
- **Settings (system_state `human_pilot`, seeded by migration 0124):** the prices and pay from product spec 16 / engineering spec 15: polish $59 / $25 (**off**), 7-day $89 / $50, 48-hour $119 / $70, 24-hour $149 / $90 (offered, as the owner chose), cover letter +$29 / +$18; **pilot cap 15 paid orders**; 24-hour pending expiry; 72-hour acceptance; 7-day revision window; revision clock 24 / 48 hours; three questions, 24 hours to answer; 3-day earnings hold; $25 minimum payout; two open jobs per expert; 90-day retention.
- **Migration 0124** (`supabase/migrations/0124_experts_phase1_pilot.sql`): additive. One nullable column on `payments` (`product_kind`); 11 new tables with row level security and no grant to anon or authenticated; 19 functions, execute revoked from public, anon and authenticated and granted to the service role; the settings seed; the ledger row and the schema version (last statements).
- **Money moves only on defined transitions, each idempotent in the database:** payment confirmed (`offered`, once), accept (exactly one pay row; a unique index is the last guard), refund (one reversal row), payout (one per idempotency key). Prices and pay are stored on the job row at checkout.
- **An expert reads or writes a client's content only through two database functions** (`human_job_expert_read`, `human_job_expert_save`, plus `human_job_expert_baseline`); each refuses unless the job is assigned to that expert and in a working state, and logs the attempt. Access ends when the revision window after delivery closes.
- **The existing hourly sweep** gets one flag-gated call (`humanSweep`): expire unanswered questions, auto-accept at 72 hours, close unpaid orders past 24 hours, retention. No new trigger.

## Phase 1: decisions made

1. **Payment rows have `scan_id = null`.** The existing checkout, the orphan sweep and the fix claim all key on a payment's scan, so a human payment tied to a scan would be mistaken for an AI Fix (and a second pending payment on one scan is blocked by `payments_scan_id_pending_uidx`). The job holds the scan link instead.
2. **Two small guarded edits in `fulfillment.service.js`:** `settlePayment` hands a human payment to `humanSettle` before the AI path runs (so no scan claim, queue, commission, fix receipt or auto-refund), and `reversePayment` closes the job when a human payment is refunded. The webhook controller, `verifyPayment` and the refund service are untouched.
3. **Refund email:** a refund uses the existing `payment_reversed` email (it already says the payment was refunded), so only three templates were added: order received, question, delivered.
4. **Currency:** human orders are sold only while the active payment currency is USD; the settings are in US dollars.
5. **Brief wording** is `docs/experts/phase0/06-checkout-wording` as written. Two lines are the Phase 0 document's own "to confirm" lines, shown as written: the sentence that the expert may be in a different country, and the lateness line, "we credit you the rush premium automatically" (the credit is not automated in Phase 1; see Known gaps).
6. **Operator reviews every delivery** (Appendix F.3): the expert submits to `in_review`; the operator reads the restored resume, confirms or sends back, then delivers. A revision goes through the same review (a transition the engineering spec's table does not list: `revision` to `in_review`).
7. **No invented facts:** every figure in the delivered text must be in the original, the AI draft, the brief, an answered question or a supporting file, or the operator confirms it (or overrides with a written reason, logged).
8. **Links** given as supporting material are kept for the operator only: nothing here can fetch and mask a web page, so an expert never sees one.

## Phase 1: tests

Full suite on the final tree (npx vitest run, both backend and frontend projects): 604 files, 8812 tests (1 todo):
  8805 passed, 6 failed, 1 todo.
  The 6 failures are the SAME 6 that fail on the untouched base commit (re-run there to confirm): frontend/tests/adminHotCategories (1),
  home.page (1), homeAdminPreview (4). The pilot adds no failure.
New tests, 175 in 9 files (all passing):
  tests/migrations.0124.pglite.test.js  24  (real Postgres via PGlite: only-adds, RLS, every function closed to anon / authenticated,
                                             assignment has one winner, expert read / save gate and its audit rows, one pay row, one
                                             reversal, one payout per key, question pause arithmetic, one revision, rating once,
                                             auto-accept)
  tests/humanLibs.test.js               31  (locking and restore, validation, diff, fact check, two-factor vectors from RFC 6238, settings)
  tests/human.settle.test.js            10  (settlement and reversal hooks: confirm once, repeats change nothing, nothing of the AI-fix
                                             path runs, an AI-fix payment still takes the old path, flag off = no extra query)
  tests/human.orders.test.js            24  (flag off = ordinary 404 for every path; allow-list; checkout; NO code path with five code
                                             kinds and a promo window; cap; refusals)
  tests/expert.test.js                  23  (sign-in, lockout, replay, realms separate, locks enforced server-side, assigned-job gate)
  tests/human.admin.test.js             22  (review, delivery, step-up, expert accounts, payouts, summary, hourly sweep and retention)
  tests/human.flagoff.test.js           19  (the money and auth files do not know the feature; mounting; sweep no-op; Paystack callback)
  frontend/tests/human/customer.test.jsx 11, expert-admin.test.jsx 11  (jsdom)
Existing tests changed: ONE line in tests/email.registry.test.js (the three new senders), required by that test. Acceptance criteria
of Appendix H that apply to Phase 1 are covered by the files above: atomic assignment, assigned-job-only reads and logged attempts,
deadline pause, earnings once on acceptance, locked fields, no invented facts, flag off changes nothing.
Frontend production build (vite build): succeeds.

## Phase 1: known gaps (full list in `CHANGES-experts-phase-1.txt`, section 7)

- Not verified from here: a live Supabase database, a real browser, real Paystack, a deployment, email delivery, Cloudflare Browser Rendering (PDF), R2, Microsoft Word. The spike resumes are synthetic.
- A card dispute does not move the job to `disputed` (inbox shows the payment status). The cap check is not atomic. The rush-premium credit and the 48-hour-late refund are not automated.
- No recovery codes, expert sessions table, idle timeout or in-app accept/decline for experts. Customers cancel in the app only until an expert is assigned.
- Supporting links are operator-only. The Human Rewrite Addendum and the Terms / Privacy changes are not in the app and must be live before the first paid order.
- Reported, not fixed: six frontend tests in three files that already fail on the untouched base (the hot-categories "sample numbers" text).

## Phase 1: to do before the first paid order (owner)

The dry run in `docs/experts/phase1/dry-run-checklist.md`, then the list at the end of `CHANGES-experts-phase-1.txt`. The operating procedure mapped to the screens is `docs/experts/phase1/operating-checklist.md`.

## Open questions (need the owner)

1. Confirm decision 1 (two tables) against engineering spec section 19.
2. Confirm or replace the one-sentence privacy line (decision 6).
3. **The bars are not set.** Section 23 says click-through and waitlist bars are set before Phase 0 starts; they are not written anywhere in the pack. The gate cannot be judged until they are.
4. Section 27 puts the "18 and over" tick for buyers in Phase 0 wording. The waitlist does not ask it. Add a tick to the waitlist form?
5. Section 6.1 says the 24-hour tier is offered only when coverage supports it. The fake door shows all four rungs, as the brief asks. Confirm.
6. Should a person be able to remove themselves from the waitlist before launch (an unsubscribe link)? Not built.

## Known gaps

- No self-service removal of a visitor's email from the waitlist; removal is by hand in the database.
- Emails given without an account are not verified (typos, or someone else's address).
- The variant belongs to a browser, not a person: another device, private browsing or cleared storage draws again. Section 6 of the results SQL checks one browser never appears under two variants.
- Account erasure (`scrub_account_data`) was not extended (it is an existing function and the rule is additive only). Signed-in waitlist rows hold the user id only, so no contact detail survives erasure; the user id row itself remains until a later phase removes it.
- Prices are shown in US dollars only, whatever currency the visitor's checkout would use.
- Bot traffic is limited by rate limits only (no bot check).
- Nothing here has been run against a live database, a real browser, a deployment or the owner's analytics.

## Existing files touched

| File | Why |
|---|---|
| `frontend/src/components/scan/FixBanner.jsx` | one import and one JSX line that mount `HumanRewriteOption` (renders nothing while the flag is off) |
| `src/index.js` | one `require` and one `app.route('/api/human-demand', ...)` |
| `src/config/constants.js` | `EXPECTED_SCHEMA_VERSION` 118 to 119 |
| `src/config/migrationLedger.js` | ledger line for 119 |

## New files

`supabase/migrations/0119_human_demand_test.sql`, `src/lib/humanDemand.js`, `src/middleware/humanDemandLimits.js`, `src/controllers/human-demand.controller.js`, `src/routes/human-demand.routes.js`, `frontend/src/lib/humanDemand.js`, `frontend/src/components/scan/HumanRewriteOption.jsx`, `docs/experts/phase-0a-results.sql`, `docs/experts/STATUS.md`, `CHANGES-experts-phase-0a.txt`, and tests `tests/humanDemand.controller.test.js`, `tests/humanDemand.routes.test.js`, `tests/migrations.0119.pglite.test.js`, `frontend/tests/components/humanRewriteOption.test.jsx`.

## Tests

- Baseline on the untouched base `ae07e09`: 577 files, 8429 tests: 7 failed, 8421 passed, 1 todo. All 7 failures are in `frontend/tests/pages/PartnerApply.test.jsx` (see below).
- With Phase 0A: the full suite's only new failure was `sharedFrontend.section11.round7d.test.jsx` (the repo forbids raw radio/checkbox inputs outside `components/ui`). Fixed by using the shared `Radio`, `Checkbox` and `Input`. Afterwards the whole frontend suite was re-run: 294 files, 2457 tests, the same 7 `PartnerApply` failures and nothing else. The backend files are unchanged since the full run that passed them, so the backend suite was not re-run after the fix.
- New tests (52): `tests/humanDemand.controller.test.js` (15), `tests/humanDemand.routes.test.js` (9), `tests/migrations.0119.pglite.test.js` (13, real Postgres via PGlite, includes the results queries), `frontend/tests/components/humanRewriteOption.test.jsx` (15).
- Flag off is proven two ways: the router answers the app's 404 on all three paths for unset, empty, `false`, `TRUE` and `1`, and nothing is written; the offer card renders no Human option, has no "human" wording and makes no event or waitlist call, with the existing offer card tests (`fixBanner.*`) unchanged and passing.
- Not run: a real browser, a live database, a deployment, a Cloudflare Worker runtime (the limiter's Durable Object path is only exercised through its exported function, stubbed).

## Unrelated issues seen (not fixed)

- `frontend/tests/pages/PartnerApply.test.jsx`: 7 tests fail on the untouched base `ae07e09` with "default.get is not a function" at `PartnerApply.jsx:34` (`fetchTermsVersion`). The page now calls `api.get` for the terms version (Partners round 41) and the test's mock of `api` has no `get`. Likely the test mock, not the page. Not fixed here.

## Phase 0B: what exists (all in `docs/experts/phase0/`)

| File | What it is |
|---|---|
| `01-style-guide-v1.docx` | Style guide v1 with 10 synthetic before/after examples. Regional notes unverified. |
| `02-sample-test-pack.docx`, `02b-rubric-scoring-sheet.xlsx` | Three synthetic test variants with graders-only answers; Appendix C scoring sheet with formulas. |
| `03-pilot-runbook.docx`, `03b-pilot-recording-sheet.xlsx` | Manual pilot procedure; per-job recording sheet with contribution formulas and the Phase 1 gate. |
| `04-terms-and-policy-changes.docx` | Quoted current wording and proposed changes for Terms, Privacy and partner terms; version and notice-flow findings. |
| `05a-client-addendum-draft.docx`, `05b-expert-agreement-draft.docx`, `11c-grader-addendum-draft.docx` | Drafts for counsel. Every page marked. Open questions boxed at the front. |
| `06-checkout-wording.docx` | The eight checkout strings with placement and the rule each enforces. |
| `07-competitor-price-sheet.xlsx` | Public listings (not quotes) for 8 services; only one read on the vendor's own page; quote script. |
| `08-payout-provider-comparison.xlsx` | Research only. Paystack, PayPal, Wise partly researched; others not. Many cells "to verify". |
| `09-data-flow-map.docx` | Table and diagram from the code; list of what could not be determined. |
| `10-explainer-faq-waitlist-copy.docx` | Explainer, FAQ, waitlist and opening emails. |
| `11a-expert-recruiting-kit.docx`, `11b-expert-shortlist-tracker.xlsx` | Application form, interview script, onboarding checklist; tracker with formulas. |
| `12-phase0-gate-sheet.xlsx` | Demand-test bars (blank), pilot bars with spec conflicts, section 27 decisions with defaults, section 22.3 checklist. |

## Spec conflicts and gaps found in Phase 0B (need the owner)

1. Section 22 (Phase 1 gate) vs section 23 (targets): revision rate under 20% vs under 15%; contribution at least $25 vs $30. The recording sheet uses section 22 until the owner decides.
2. The Human polish tier has no turnaround or deadline in the product or engineering spec, so its late-credit rule and promise cannot be written.
3. Appendix E proposes 90-day retention; section 27 says 30 to 90 days.
4. Existing Terms and Privacy say minimum age 16; Human rewrite is 18 and over. Privacy section 4 says resumes are not shared with any other party. Terms section 3 says every paid purchase includes a cover letter.
5. Partner terms (section 3 and `ATTRIBUTION_TERMS`) say every purchase earns commission; spec 16.7 says none on human jobs.
6. `TERMS_VERSION` is `2026-09` but `Terms.jsx` shows a last-updated date of 23 Oct 2026. Not fixed.
7. Spec 2.6 defines "verified" for the expert; in the pilot the experts are not yet verified, so copy must say "vetted by us".

## Phase 0 non-code checklist

- [~] Three to five competitor quotes in the main target markets. PARTLY: public listings and a quote script drafted (07). **Needs you:** send the requests and record real quotes.
- [~] Expert shortlist (three to five; two known, at least two unknown). PARTLY: recruiting kit and tracker built (11a, 11b), test pack (02, 02b). **Needs you:** recruit, test, interview.
- [~] Legal drafts: expert agreement, grader addendum, client addendum, privacy text; start legal review. PARTLY: drafts and counsel questions done (04, 05a, 05b, 11c). **Needs you:** engage counsel.
- [~] Payout provider: shortlist and apply; check payout rails per country. PARTLY: research only (08), several providers not researched, many items "to verify". **Needs you:** choose, apply.
- [x] Data-flow map for counsel. DONE (09), with a list of unknowns that need answers.
- [~] Copy: checkout wording (18-plus tick, third-party data, optional improvement consent). DONE as drafts (06), blocked in one place: polish late rule. **Needs you** and counsel to approve.
- [x] Style guide and review rubric. DONE as v1 (01, 02, 02b). Regional notes need confirming.
- [~] Confirm no code, promo or welcome path can reach a human order; check partner terms wording (16.7). PARTLY: partner wording changes drafted (04, PT1 to PT4). The code-path check is a Phase 1 build and test item, not done here.
- [ ] Approve the section 27 defaults and set the pilot bars (section 23). **Needs you:** use `12-phase0-gate-sheet.xlsx`.
- [x] Waitlist copy and explainer written. DONE as drafts (10).
- [x] Pilot runbook and recording sheet (needed before Phase 1). DONE as drafts (03, 03b).
