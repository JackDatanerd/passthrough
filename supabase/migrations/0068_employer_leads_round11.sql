-- Employer leads, round 11 (independent audit, Section 5; migration 0068). Idempotent — safe to re-run.
--
-- 1. consent / confirmed_via — a per-lead record of HOW the lead came to be mailable: the public
--    form (with the page it came from), an admin typing it in, a CSV import (and which admin
--    attested to it), or a re-join. confirmed_via says who vouched for the address: the inbox owner
--    ('link'), an admin ('admin', 'manual', 'import') or the re-join email ('rejoin'). Nullable —
--    rows from before this migration simply have no record (and 'manual' ones are backfilled).
-- 2. candidates_notified_fields — when each FIELD's "there are Verified candidates" email was last
--    sent to the lead, as {"sales": "<iso>", ...}. The single last_candidates_notified_at could not
--    tell a lead hiring in two fields that it had only been told about one. Backfilled from the old
--    timestamp so nobody is mailed twice for a field they were already told about.
-- 3. employer_lead_suppressions.reason — why an address is on the do-not-contact list ('self' = they
--    used their own remove link; 'admin', 'complaint', 'bounce', 'purge'). Only 'self' entries can be
--    re-opened by the person themselves (the re-join email); NULL (written before this migration) is
--    treated as "unknown" and is never re-openable.
-- 4. idx_employer_leads_email — migration 0021 replaced the plain unique constraint with an index on
--    lower(email), so every `.eq('email', …)` lookup (resubmission, confirm, remove, webhook, import,
--    the acknowledgement sweep) could not use any index. Emails are lower-case by constraint (0032).
-- 5. employer_leads_extras_valid — the "other fields" list never contains the primary field and does
--    not exist without one. Application code kept that true on most paths, not all (a lead whose
--    primary field was set from the confirm page could end up listed twice, and open_lead_counts()
--    counts every entry). Existing violations are repaired first, then the rule becomes a constraint.
-- 6. set_lead_field() — "set the field on these leads" as ONE statement. The bulk action used to write
--    the primary field for every lead and then fix each lead's other-fields list in a loop of single
--    updates; a failure part-way left the first write committed and the lists wrong.

alter table employer_leads add column if not exists consent                       jsonb;
alter table employer_leads add column if not exists confirmed_via                 text;
alter table employer_leads add column if not exists candidates_notified_fields    jsonb not null default '{}'::jsonb;
alter table employer_lead_suppressions add column if not exists reason            text;

update employer_leads set confirmed_via = 'manual'
 where source = 'manual' and confirmed_at is not null and confirmed_via is null;

-- Carry the old single timestamp over to every field the lead is waiting on.
update employer_leads l
   set candidates_notified_fields = coalesce((
         select jsonb_object_agg(f.cat, l.last_candidates_notified_at)
           from unnest(array[l.role_category] || l.extra_role_categories) as f(cat)
          where f.cat is not null), '{}'::jsonb)
 where l.last_candidates_notified_at is not null
   and l.candidates_notified_fields = '{}'::jsonb;

create index if not exists idx_employer_leads_email on employer_leads (email);

-- Repair, then enforce, the "other fields" rule.
update employer_leads set extra_role_categories = '{}'
 where role_category is null and cardinality(extra_role_categories) > 0;
update employer_leads set extra_role_categories = array_remove(extra_role_categories, role_category)
 where role_category is not null and role_category = any(extra_role_categories);
update employer_leads
   set extra_role_categories = (select coalesce(array_agg(distinct x), '{}'::text[]) from unnest(extra_role_categories) as x)
 where cardinality(extra_role_categories) <> (select count(distinct x) from unnest(extra_role_categories) as x);

alter table employer_leads drop constraint if exists employer_leads_extras_valid;
alter table employer_leads add  constraint employer_leads_extras_valid
  check ((role_category is not null or cardinality(extra_role_categories) = 0)
         and not (role_category = any(extra_role_categories)));

create or replace function set_lead_field(p_ids uuid[], p_field text)
returns table (id uuid)
language sql
security definer
set search_path = public
as $$
  update employer_leads l
     set role_category         = p_field,
         extra_role_categories = case when p_field is null then '{}'::text[]
                                      else array_remove(l.extra_role_categories, p_field) end,
         updated_at            = now()
   where l.id = any(p_ids)
  returning l.id;
$$;

revoke execute on function set_lead_field(uuid[], text) from public, anon, authenticated;
grant  execute on function set_lead_field(uuid[], text) to service_role;

-- Always the LAST statement of a migration: records how far this database has been migrated.
insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 68, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now();
