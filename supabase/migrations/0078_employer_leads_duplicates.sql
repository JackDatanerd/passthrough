-- Employer leads, round 12 follow-up (migration 0078). Idempotent — safe to re-run.
--
-- duplicate_leads() — leads that share an INBOX (employer_leads.mailbox_key, migration 0076), for the admin
-- "Duplicates" view and merge. Leads are stored under the address as typed, so hiring@ and hiring+eng@ are two
-- rows; this lists every row whose mailbox appears more than once, grouped by mailbox, capped so the answer
-- stays small (the endpoint drops the last, possibly cut-off, group when the cap is hit).
--
-- Requires 0076 (the mailbox_key column). Apply after 0077 (database layer audit).

create or replace function duplicate_leads(p_limit int default 200)
returns table (
  id uuid, mailbox_key text, email text, name text, company text, status text,
  role_category text, confirmed_at timestamptz, created_at timestamptz, submission_count int
)
language sql
stable
security definer
set search_path = public
as $$
  select l.id, l.mailbox_key, l.email, l.name, l.company, l.status::text,
         l.role_category, l.confirmed_at, l.created_at, l.submission_count
    from employer_leads l
   where l.mailbox_key in (
           select d.mailbox_key from employer_leads d
            where d.mailbox_key is not null
            group by d.mailbox_key having count(*) > 1)
   order by l.mailbox_key, l.created_at
   limit greatest(1, least(coalesce(p_limit, 200), 500));
$$;

revoke execute on function duplicate_leads(int) from public, anon, authenticated;
grant  execute on function duplicate_leads(int) to service_role;

-- Always the LAST statement of a migration: records how far this database has been migrated.
insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 78, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 78;   -- never move the version BACKWARDS (a re-run of an older file)
