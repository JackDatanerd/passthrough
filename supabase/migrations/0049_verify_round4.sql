-- Verify, audit round 4 (0049). Idempotent — safe to re-run.
--
-- Apply BEFORE deploying the code: the code degrades gracefully without it (tombstoned-file
-- lookup simply finds nothing; download counting logs and carries on), but neither feature
-- works until this is in.

-- ── verification_tombstone_hashes ───────────────────────────────────────────
-- A page that was deleted (its scan, or its owner's whole account) used to leave only its
-- CODE behind, so GET /api/verify/by-hash/:sha256 answered NO_MATCH for a genuine,
-- unmodified Passthrough file — and the lookup page told the reader the file had been
-- edited or was not from Passthrough. The SHA-256 of each file the page ever covered
-- (current + superseded) now outlives the page, so the lookup can say "removed by its
-- owner" instead. A hash is not reversible and names no one; the code is already kept.
create table if not exists verification_tombstone_hashes (
  hash       text primary key,
  code       text not null,
  removed_at timestamptz not null default now()
);
create index if not exists idx_vtomb_hashes_code on verification_tombstone_hashes (code);
alter table verification_tombstone_hashes enable row level security;   -- service-role only (see 0014)

-- ── download counting ───────────────────────────────────────────────────────
-- Owners saw how often the page was VIEWED but never whether anyone took the file.
alter table scans add column if not exists verification_downloads int not null default 0;

create or replace function increment_verification_downloads(p_code text)
returns void
language sql
security definer
set search_path = public
as $$
  update scans
  set verification_downloads = verification_downloads + 1
  where verification_code = p_code;
$$;
revoke execute on function increment_verification_downloads(text) from public, anon, authenticated;
grant  execute on function increment_verification_downloads(text) to service_role;
