-- Which Claude model wrote a delivered resume / cover letter, recorded per delivery next to the prompt generation (0094) so a
-- model switch (e.g. claude-sonnet-4-6 -> claude-sonnet-5-5, ANTHROPIC_MODEL in wrangler.toml) can be judged on the only ground
-- truth the product collects: whether people got interviews.
--
-- scans.fix_model     - ANTHROPIC_MODEL in force when the fix was written (null = before this column existed, or a Badge /
--                       a fix whose rewrite failed and delivered the original).
-- scans.letter_model  - the same for the cover letter.
--
-- Both are written best-effort AFTER delivery, so the worker may be deployed before or after this migration.

alter table scans add column if not exists fix_model    text;
alter table scans add column if not exists letter_model text;

-- Interview rate per model, same shape and same security_invoker treatment as prompt_outcome_rates (0094 / 0100).
create or replace view model_outcome_rates as
select s.fix_model                                                     as model,
       count(*)                                                        as responses,
       count(*) filter (where o.outcome = 'INTERVIEW')                 as interviews,
       round(100.0 * count(*) filter (where o.outcome = 'INTERVIEW')
             / nullif(count(*) filter (where o.outcome in ('INTERVIEW', 'NO_INTERVIEW')), 0), 1) as interview_pct
from scan_outcomes o
join scans s on s.id = o.scan_id
where o.outcome in ('INTERVIEW', 'NO_INTERVIEW')
group by s.fix_model;
alter view model_outcome_rates set (security_invoker = true);

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (109, '0109_model_stamp')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 109, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 109;   -- never move the version BACKWARDS (a re-run of an older file)
