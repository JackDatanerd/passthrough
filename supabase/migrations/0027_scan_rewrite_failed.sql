-- AUDIT FIX (feature gap — Scan/ATS section audit, round 2): generateFix
-- (scan.controller.js) could previously deliver a paid "Fix" that was, in
-- substance, the user's ORIGINAL unmodified resume — every attempt in the
-- rewrite loop hit a raw API error, a truncated response, or fabricated
-- content with no attempts left to retry — with no durable record anywhere
-- that this specific delivery was a system-side failure rather than a
-- legitimate rewrite that simply landed under the badge threshold. The
-- existing "grant a free credit" safety net only ever fired once a user
-- manually exhausted MAX_FIX_RETRIES — the very first occurrence, on a
-- scan's initial generateFix run, got neither an explanation nor automatic
-- compensation.
--
-- This column lets generateFix persist that distinction so:
--   1. ScanResult.jsx can show an honest "we hit a system issue generating
--      your rewrite — this is your original resume, unchanged" message
--      instead of the normal "below threshold, here's why" copy.
--   2. A future admin/support view can filter for these without having to
--      diff original_resume_data against rewritten_resume_data by hand.
--
-- Defaults false and is reset on every generateFix delivery (never sticky
-- across retries) — see scan.controller.js's generateFix for where it's
-- set. generateBadge never touches this column (badge purchases have no
-- rewrite loop at all), so it stays false for every BADGE-tier scan.
alter table scans
  add column if not exists rewrite_failed boolean not null default false;

comment on column scans.rewrite_failed is
  'True when the most recent generateFix delivery could not produce any usable rewrite (every attempt hard-failed) and delivered the original, unmodified resume instead. Reset on every generateFix run; never set by generateBadge.';
