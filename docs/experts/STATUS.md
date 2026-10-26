# Passthrough Experts: build status

Contract: `passthrough-experts-spec-pack-index.docx` (read first), `passthrough-experts-spec-v2.2.docx` (product intent), `passthrough-experts-engineering-spec-v1.1.docx` (technical detail). The existing code wins over any description of it.

## Base

- Phase 0A was built on commit `ae07e09` (26 Oct 2026, 13:34 +03:00, "Partners round 41 ...").
- Earlier drafts were checked against `7388d37` and `38817f2` (24 Oct). Between `7388d37` and `ae07e09` no file this work touches or depends on changed.
- Next free migration at the time: **0119** (files, ledger and `EXPECTED_SCHEMA_VERSION` all stood at 118).

## Phases

| Phase | Name | State |
|---|---|---|
| 0 | Demand test and groundwork | **0A (the demand test code) delivered, not yet deployed.** The non-code rest of Phase 0 is not started (checklist below). |
| 1 | Concierge pilot | not started |
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

## Phase 0 non-code checklist (all NOT STARTED)

- [ ] Three to five competitor quotes in the main target markets
- [ ] Expert shortlist: three to five, the two the founder knows and at least two the founder does not
- [ ] Legal drafts: expert agreement, grader addendum, client addendum, privacy text; start legal review
- [ ] Payout provider: shortlist and apply (approval can take weeks); check payout rails for each expert country
- [ ] Data-flow map for counsel
- [ ] Copy: checkout wording for the 18-plus tick, third-party data and the optional improvement consent
- [ ] Style guide and review rubric
- [ ] Confirm no code, promo or welcome path can reach a human order; check partner terms wording (section 16.7)
- [ ] Approve the section 27 defaults and set the pilot bars (section 23)
