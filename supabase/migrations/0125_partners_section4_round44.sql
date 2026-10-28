-- Partners section 4, round 44: channel-tag eviction can no longer be used to wipe a partner's fresh stats.
-- A full code (50 tags) used to evict its quietest unattributed tag the moment a new tag arrived, so spamming made-up
-- ?sub= values could displace real channels that had clicks but no sale yet. Tags now carry a creation time and only a
-- tag older than 7 days can be displaced; a newcomer arriving while every tag is fresh or attributed is simply not tracked.
alter table referral_sub_clicks add column if not exists created_at timestamptz not null default now();

create or replace function increment_referral_sub_clicks(p_code text, p_sub text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    uuid;
  v_evict text;
begin
  if p_sub is null or p_sub !~ '^[a-z0-9_-]{1,32}$' then return; end if;

  select rc.id into v_id
    from referral_codes rc
   where rc.code = p_code
     and rc.active
     and (rc.expires_at is null or rc.expires_at > now())
     and exists (select 1 from partners p where p.id = rc.partner_id and p.status = 'ACTIVE');
  if v_id is null then return; end if;

  perform pg_advisory_xact_lock(hashtext('referral_sub_clicks:' || v_id::text));

  update referral_sub_clicks set clicks = clicks + 1 where code_id = v_id and sub = p_sub;
  if found then return; end if;

  if (select count(*) from referral_sub_clicks where code_id = v_id) >= 50 then
    select t.sub into v_evict
      from referral_sub_clicks t
     where t.code_id = v_id
       and t.created_at < now() - interval '7 days'
       and not exists (select 1 from payments p where p.referral_code_id = v_id and p.referral_sub = t.sub)
       and not exists (select 1 from users u, referral_codes rc
                        where rc.id = v_id and u.referred_by_code = rc.code and u.referred_sub = t.sub)
     order by t.clicks asc, t.sub asc
     limit 1;
    if v_evict is null then return; end if;
    delete from referral_sub_clicks where code_id = v_id and sub = v_evict;
  end if;

  insert into referral_sub_clicks (code_id, sub, clicks) values (v_id, p_sub, 1);
end;
$$;
revoke execute on function increment_referral_sub_clicks(text, text) from public, anon, authenticated;
grant  execute on function increment_referral_sub_clicks(text, text) to service_role;

insert into applied_migrations (version, name) values (124, '0124_partners_section4_round44')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 124, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 124;
