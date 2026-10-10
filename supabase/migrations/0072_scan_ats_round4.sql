-- Scan/ATS round 4.
--
-- 1. claude_usage: one row per Claude call (cost ledger). Written best-effort by lib/claudeUsage.js; the code keeps
--    working if this table does not exist yet.
-- 2. scans.scan_slot_spent_at: WHEN the free-scan slot behind a scan was actually spent. A retry-scan spends a new
--    slot long after created_at, but the refund rules (index.js stuck-scan sweep, refundScanQuota, refundScanSlot)
--    compared created_at to "today" / "an hour ago", so a retry that failed on our side after midnight UTC was never
--    given back. Written best-effort by createScan / retryScan; refunds fall back to created_at while it is null.

create table if not exists claude_usage (
  id            bigserial primary key,
  scan_id       uuid references scans(id) on delete set null,
  label         text not null,
  model         text,
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  created_at    timestamptz not null default now()
);
create index if not exists claude_usage_scan_idx    on claude_usage (scan_id);
create index if not exists claude_usage_created_idx on claude_usage (created_at);
alter table claude_usage enable row level security;   -- service role only, like every other server-side table

alter table scans add column if not exists scan_slot_spent_at timestamptz;

-- Always the LAST statement of a migration: records how far this database has been migrated.
insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 72, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now();
