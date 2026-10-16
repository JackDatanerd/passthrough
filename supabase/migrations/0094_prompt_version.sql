-- Document-writing prompt generation, recorded per delivery so the interview outcomes people report (scan_outcomes)
-- can be compared across prompt versions. Until now nothing recorded which prompt wrote a resume or a letter, so a
-- better prompt and a worse one were indistinguishable in the only ground truth the product collects.
--
-- scans.prompt_version         - claude.service.js PROMPT_VERSION in force when the fix was written (null = before this
--                                column existed, or a Badge / a fix whose rewrite failed and delivered the original).
-- scans.letter_prompt_version  - the same for the cover letter.
--
-- Both are written best-effort AFTER delivery, so the worker may be deployed before or after this migration.

alter table scans add column if not exists prompt_version        text;
alter table scans add column if not exists letter_prompt_version text;

-- Interview rate per prompt generation. Counts only people who answered; the response count travels with the rate so a
-- small sample is visible as small. Read by the admin / by hand - nothing public.
create or replace view prompt_outcome_rates as
select s.prompt_version,
       count(*)                                                        as responses,
       count(*) filter (where o.outcome = 'INTERVIEW')                 as interviews,
       round(100.0 * count(*) filter (where o.outcome = 'INTERVIEW')
             / nullif(count(*) filter (where o.outcome in ('INTERVIEW', 'NO_INTERVIEW')), 0), 1) as interview_pct
from scan_outcomes o
join scans s on s.id = o.scan_id
where o.outcome in ('INTERVIEW', 'NO_INTERVIEW')
group by s.prompt_version;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (94, '0094_prompt_version')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 94, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 94;   -- never move the version BACKWARDS (a re-run of an older file)
