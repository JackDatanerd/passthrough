-- Employer leads, round 10 (independent audit, Section 5; migration 0062).
--
-- 1. Acknowledgement retry. A new lead's confirmation email was attempted exactly once, in the
--    background. If the hourly budget was spent, Resend failed or the isolate was cut off, the lead
--    stayed unacknowledged forever (and the unconfirmed-lead purge later deleted it without it ever
--    having been asked to confirm). ack_attempts / last_ack_attempt_at let an hourly sweep retry
--    those leads a bounded number of times without starving the rest of the queue.
-- 2. archived_resubmitted_at: an ARCHIVED lead that submits the form again stays archived (the
--    dismissal stands) but is flagged so the admin can see it came back.
-- 3. extra_role_categories: an employer hiring in more than one field. role_category stays the
--    primary field; the others live here so candidate notifications and the waiting-lead counts
--    can match every field a lead said it is hiring in.

alter table employer_leads add column if not exists ack_attempts             smallint    not null default 0;
alter table employer_leads add column if not exists last_ack_attempt_at      timestamptz;
alter table employer_leads add column if not exists archived_resubmitted_at  timestamptz;
alter table employer_leads add column if not exists extra_role_categories    text[]      not null default '{}';

alter table employer_leads drop constraint if exists employer_leads_extra_fields_max;
alter table employer_leads add  constraint employer_leads_extra_fields_max
  check (cardinality(extra_role_categories) <= 4);

-- The ack sweep's working set: unconfirmed, never acknowledged, not dismissed.
create index if not exists employer_leads_unacked_idx
  on employer_leads (last_ack_attempt_at nulls first, created_at)
  where last_ack_at is null and confirmed_at is null and status <> 'ARCHIVED';

-- Waiting leads per field now count every field a lead is hiring in.
drop function if exists open_lead_counts();

create or replace function open_lead_counts()
returns table (role_category text, lead_count bigint, confirmed_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select f.cat,
         count(*)::bigint,
         (count(*) filter (where l.confirmed_at is not null))::bigint
  from employer_leads l
  cross join lateral unnest(array[l.role_category] || l.extra_role_categories) as f(cat)
  where l.status in ('NEW', 'CONTACTED')
    and f.cat is not null
  group by f.cat;
$$;

revoke execute on function open_lead_counts() from public, anon, authenticated;
grant  execute on function open_lead_counts() to service_role;

-- Always the LAST statement of a migration: records how far this database has been migrated.
insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 62, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now();
