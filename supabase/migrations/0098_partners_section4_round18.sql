-- Partners / Referral program, section 4 round 18.
--
-- Per-channel click counts. The partner's channel tag (`&sub=`) already rode along on every SALE (0093), but clicks were
-- only counted per code, so "Sales by channel" could never show how many visits each channel brought or its conversion
-- rate. One row per (code, tag). Additive and idempotent. Service role only, like every other counter here.

create table if not exists referral_sub_clicks (
  code_id uuid not null references referral_codes(id) on delete cascade,
  sub     text not null check (sub ~ '^[a-z0-9_-]{1,32}$'),
  clicks  int  not null default 0,
  primary key (code_id, sub)
);
alter table referral_sub_clicks enable row level security;

-- Same gate as increment_referral_code_clicks (0051): only a code that can actually apply today accumulates clicks.
create or replace function increment_referral_sub_clicks(p_code text, p_sub text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into referral_sub_clicks (code_id, sub, clicks)
  select rc.id, p_sub, 1
    from referral_codes rc
   where rc.code = p_code
     and p_sub ~ '^[a-z0-9_-]{1,32}$'
     and rc.active
     and (rc.expires_at is null or rc.expires_at > now())
     and exists (select 1 from partners p where p.id = rc.partner_id and p.status = 'ACTIVE')
  on conflict (code_id, sub) do update set clicks = referral_sub_clicks.clicks + 1;
$$;
revoke execute on function increment_referral_sub_clicks(text, text) from public, anon, authenticated;
grant  execute on function increment_referral_sub_clicks(text, text) to service_role;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (98, '0098_partners_section4_round18')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 98, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 98;   -- never move the version BACKWARDS (a re-run of an older file)
