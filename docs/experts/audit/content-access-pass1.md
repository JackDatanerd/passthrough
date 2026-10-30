# Experts audit A3, pass 1: Phase 1 database layer, content access

Base `c92d0cb` (30 Oct 2026; first pass written on `9e79fa1`, rebased after A2 and A5 landed). Scope: migration 0124 content functions (`human_job_expert_read/save/baseline`, `human_job_assign/unassign`), the locked-value storage (`job_locked_values`, `fieldCrypto`), `humanLocks.js`, and the code that feeds them. Every finding below was reproduced (PGlite against the real migrations, or Node) before it was fixed. Fixes are in migration **0128** plus library and controller changes; regression tests are in `tests/experts.a3.contentAccess.test.js` and an addition to `human.admin`.

## Gaps
- **G1 customer free text reached the expert unmasked** (brief notes, answers, the revision reason, the file label). Found here and closed at the same time by audit A5 (`lib/expertView.js`, read-time scrub); A3 adds no second mechanism. The database function still returns the raw text, so any new caller of `human_job_expert_read` must go through `presentForExpert`.
- **G2 no conflict-of-interest check.** `human_job_assign` refuses an expert whose email is the customer's (`conflict_of_interest`).

## Bugs fixed
1. `human_job_expert_read` failed open on NULL (a NULL expert, or a NULL window on a delivered job, granted access). The gate is now `coalesce(..., false)` with `is not distinct from`.
2. `human_job_expert_save` skipped the version check on a NULL base version; it now answers `bad_request` (also for a non-object body). `save` and `baseline` refuse a NULL expert.
3. `human_job_unassign` from `waiting_customer` stranded a pending question (unanswerable, never expired, counted toward the question limit). It is now closed and the wait is folded into both deadlines, as answering or expiring it would have done.
4. Name masking, accents and web-address endings: closed by A5's rewrite of `humanLocks.js`. One piece left, now fixed: an isolated two-letter name part ("Li" in "Li Wu") was never masked; it is, unless it is an ordinary English word.
5. `fieldCrypto.hasKey` is async but was used without `await`, so the "no key" refusal never fired. Fixed in `human.controller.js`; a test fails if any caller drops the `await`.
6. An unreadable sealed locked value read as `''` and restored as a blank name and email. `openSealedStrict` throws; the review and delivery stop with `LOCKED_UNREADABLE` (503 for the operator) and a later upload can no longer lock text over a lost value (`openSealedStrict`).
7. Smaller: a save that omitted the cover letter wiped a paid-for one, and an expert could add one to a job that bought none (now follows `add_cover_letter`); `assign` / `unassign` took a non-UUID id to a 500.

## Not changed, and why
- The questions-per-job limit (3) still counts a question asked by an expert who was later unassigned. It is a per-job limit in the spec.
- Phone numbers of 7 to 8 digits are not masked (a looser rule would blank ordinary figures).
- Locked values still use the tax-ID key with no job or path bound in; key separation is A9's item.
- The 2A engine tables (`job_next_actions`, `job_pauses`) are not touched by the Phase 1 functions; that divergence is A4's.
