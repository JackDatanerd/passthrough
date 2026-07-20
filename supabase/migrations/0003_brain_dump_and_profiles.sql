-- Phase 0 — schema foundation for the brain-dump / diff-view / profile-reuse merge.
-- Run after 0001_init.sql and 0002_helpers.sql.
--
-- Summary of changes:
--   1. scans.resume_path / resume_original_name / resume_mime_type become
--      nullable — a brain-dump or saved-profile scan has no uploaded file at all,
--      not just a missing path. All three were `not null` in 0001; a brain-dump
--      scan would fail the insert without this.
--   2. scans gains an input_mode enum so every scan records which entry path
--      created it. Existing rows backfill to 'file' (every row created before
--      this migration came from the upload flow — that's the only path that
--      existed until now).
--   3. scans gains four new columns: raw_brain_dump_text (Phase 1),
--      original_resume_data + rewritten_resume_data (Phase 2 diff view),
--      quantification_prompts (Phase 3).
--   4. users gains saved_profile (Phase 4 — reuse hook).
--
-- No existing column is dropped or renamed. No existing NOT NULL constraint
-- is tightened. This migration is purely additive/relaxing and safe to run
-- against a table with live rows.

-- ── 1. Relax file-related NOT NULL constraints ────────────────────────────

alter table scans alter column resume_path          drop not null;
alter table scans alter column resume_original_name drop not null;
alter table scans alter column resume_mime_type      drop not null;

-- ── 2. input_mode enum + column ─────────────────────────────────────────

create type scan_input_mode_enum as enum ('file', 'brain_dump', 'saved_profile');

alter table scans
  add column input_mode scan_input_mode_enum not null default 'file';

-- Backfill: every row that exists before this migration came from the
-- upload flow, since that was the only entry path. The column default
-- above already covers this for existing rows, but stated explicitly
-- here in case the default is ever changed later without re-checking
-- historical data.
update scans set input_mode = 'file' where input_mode is null;

-- ── 3. Brain-dump input storage (Phase 1) ───────────────────────────────

alter table scans
  add column raw_brain_dump_text text;
-- Populated only when input_mode = 'brain_dump'. Truncated to
-- MAX_RESUME_CHARS by the application layer before storage, same limit
-- applied to extracted file text.

-- ── 4. Diff view storage (Phase 2) ──────────────────────────────────────

alter table scans
  add column original_resume_data   jsonb,
  add column rewritten_resume_data  jsonb;
-- Both are the same shape Claude's parseResumeStructure /
-- rewriteResumeContent already produce in memory during generateFix and
-- generateBadge — previously discarded after rendering, now persisted so
-- the frontend diff view has something to render against.

-- ── 5. Quantification prompts storage (Phase 3) ─────────────────────────

alter table scans
  add column quantification_prompts jsonb;
-- Array of { bullet: string, suggestion: string } objects, extracted from
-- rewriteResumeContent's extended JSON response. Static suggestions only
-- in v1 — no regeneration loop (see Phase 3 scoping note).

-- ── 6. Saved profile on users (Phase 4) ─────────────────────────────────

alter table users
  add column saved_profile jsonb;
-- Stores the same resumeData shape as scans.original_resume_data /
-- rewritten_resume_data, captured from a user's most recent completed fix.
-- Populated by profile.controller.js (Phase 4). Null until a user has
-- completed at least one fix and opted to save it.

-- ── Indexes ───────────────────────────────────────────────────────────

create index idx_scans_input_mode on scans (input_mode);
