# A10 pass 1: migrations and schema consistency

Base `aef2905` (31 Oct 2026; first read on `7ac8e06`, re-cloned when A6 landed 0130). Scope: `supabase/migrations/*` (0119, 0124, 0125, 0127 to 0130 in depth), `migrationLedger.js`, `EXPECTED_SCHEMA_VERSION`, `health.js` ledger check, the rollback script, the deploy docs that describe migration order.

Method: all migration files applied twice to a real Postgres (PGlite; first all of them, then 0082 on again) with Supabase's default privileges recreated (checked that the recreation really grants); catalog interrogated for RLS, table / sequence / view / function privileges, `search_path`; catalog diffs per migration; every self-recording line parsed in every file; the real `checkSchema()` run against the ledger a fresh apply leaves; the rollback script executed, not read.

## Findings and what was done

| # | Finding | Fix |
|---|---|---|
| B1 | `0125` recorded itself as version 124 (ledger row and `schema_version`). On a fresh database there was never a row for 125, so `checkSchema()` returned `missing: [125]`: `/healthz` 503, a daily owner alert, and its advice ("run that file again") could not clear it because the file re-records 124. `LEDGER_NAMES` had no 125; three repo tests were red at HEAD. A database that ran the file under its old number before the Experts 0124 also holds the wrong name on row 124. | 0125 records 125 (ledger, `schema_version`, guard); a guarded step gives row 124 its own name back where the Experts tables exist; `LEDGER_NAMES[125]`. Re-running 0125 repairs an existing database. |
| B2 | The round-44 test for 0125 lived in `tests/migrations.0124.pglite.test.js`, which the Experts commit overwrote (same name). 0125's behaviour had no test, and `migrations.0099` (2) and `migrations.0100` (1) still asserted the pre-0125 eviction. | New `tests/migrations.0125.pglite.test.js` (eviction guard, attribution protection, ledger, repair both ways, idempotence); 0099 / 0100 updated to the 7-day rule. |
| B3 | `rollback-0127.sql` failed when run as written (its 0129 block ran after the table drop), knew nothing of 0128 and 0130, and ended with contradictory schema-version instructions. | Replaced by `scripts/experts-rollback.cjs`, derived from the migration files; `tests/migrations.rollback.pglite.test.js` runs it one step at a time and in one script and compares tables, function bodies and privileges, triggers, indexes, rules, ledger and schema version with a database built from the older files, then re-applies the migrations. |
| B4 | `phase2a/deployment-checklist.md` said the code expects 127 and applied only 0127. | Rewritten for "every file up to the newest", with the ledger check and the 0125 repair. |
| B5 | `STATUS.md` had a literal `%s` where a commit hash belongs. | `df44f21`. |

Feature gaps built: G1 per-file self-check (every file from 0059 writes its own number, guards with it, and records with `on conflict do nothing`); G2 the tested rollback above (also reaches 0124 / 0119 behind `--include-phase1`, never drops `expert_audit_log`); G3 a migration runbook at the end of `DEPLOYMENT.md` (apply order per migration from 0119; the 0126 "Worker first" exception) with a test that fails when a new migration has no row.

## Checked and clean

All 129 (now 130) files apply, and the range from 0082 re-applies, with no error. Every table has RLS and no anon / authenticated privilege; no sequence or view is open; no function is executable by public, anon or authenticated; every `security definer` function pins `search_path`. Holds for 0119, 0124, 0127, 0128, 0129, 0130 (new functions are born closed: an earlier migration changed the schema's default function privileges, so the revoke lines are defence in depth). No migration depends on pgcrypto functions (they live in `extensions` on Supabase). Re-running the 0127 backfill after the engine has run creates no duplicate pauses. 0130's ledger, version, grants and rollback are correct.

## Noted, not changed

- 0125 stamps every existing channel tag with the migration time (`created_at default now()`), so no existing tag can be displaced for 7 days after deploy; a full code will not track new tags for a week. Acceptable; stated here.
- Re-running one older function-defining migration on its own restores that migration's function versions until the later ones are re-run. The health message already says to re-run everything after it.
- Rollback does not drop columns added to surviving tables (nullable, ignored by older code; dropping would delete data such as a payout's void reason) and does not undo 0129's repair of backfilled pauses (the rebuilt rows are the correct ones).

## Not tested

A real Supabase project (its platform roles and default ACLs are recreated, not the real thing), the production ledger (check `select version, name from applied_migrations where version >= 119 order by version;`: after pulling this, run the current 0125 once), real concurrency (PGlite is one connection).
