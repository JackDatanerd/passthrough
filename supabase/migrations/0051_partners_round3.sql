-- 0051: partners / referral program, round 3 (Section 4 deep audit).
-- Idempotent — safe to re-run. APPLY THIS BEFORE DEPLOYING the matching Worker
-- code: recordConversion now writes commission_ledger.currency and the admin
-- partner view selects it.

-- 1. "Become a partner" applications. Public intake (POST /api/partners/apply);
--    the admin approves (creates the partner) or rejects. One PENDING application
--    per email so the form can't be used to flood the review queue.
create table if not exists partner_applications (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  email       text not null,
  audience    text,
  website     text,
  message     text,
  status      text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  partner_id  uuid references partners(id) on delete set null,
  created_at  timestamptz not null default now(),
  reviewed_at timestamptz
);
create unique index if not exists partner_applications_one_pending_per_email
  on partner_applications (lower(email)) where status = 'PENDING';
create index if not exists partner_applications_status_created_idx
  on partner_applications (status, created_at desc);
alter table partner_applications enable row level security;
revoke all on partner_applications from anon, authenticated;

-- 2. The ledger had no currency of its own — commissions silently relabelled if
--    PAYSTACK_CURRENCY ever changed. Store the sale's currency per row (nullable:
--    reversal rows copy it from their original; backfilled below from payments).
alter table commission_ledger add column if not exists currency text;
update commission_ledger cl
   set currency = p.currency
  from payments p
 where cl.payment_id = p.id and cl.currency is null;

-- 3. Click counting only for codes that can actually apply today — an inactive,
--    expired or paused-partner link no longer accumulates "clicks".
create or replace function increment_referral_code_clicks(p_code text)
returns void
language sql
security definer
set search_path = public
as $$
  update referral_codes rc
     set clicks = clicks + 1
   where rc.code = p_code
     and rc.active
     and (rc.expires_at is null or rc.expires_at > now())
     and exists (select 1 from partners p where p.id = rc.partner_id and p.status = 'ACTIVE');
$$;
revoke execute on function increment_referral_code_clicks(text) from public, anon, authenticated;
grant  execute on function increment_referral_code_clicks(text) to service_role;

-- 4. A refunded/charged-back sale frees the usage slot it consumed on a limited
--    code (called once, by the call that inserts the reversal row).
create or replace function decrement_referral_code_usage(p_code_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update referral_codes set uses_so_far = greatest(uses_so_far - 1, 0) where id = p_code_id;
$$;
revoke execute on function decrement_referral_code_usage(uuid) from public, anon, authenticated;
grant  execute on function decrement_referral_code_usage(uuid) to service_role;
