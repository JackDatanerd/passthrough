-- Partners section 4, round 40.
--
-- rename_referral_code(): correcting a code's text used to be three separate writes from the Worker (referral_codes, then users,
-- then payments) with a hand-rolled undo. If the Worker died between them, buyers or payments kept pointing at text that no longer
-- matched any code. The whole rename is now one transaction. Raises unique_violation (23505) when the new text is taken and
-- no_data_found (P0002) when the code does not exist; returns the previous text.

create or replace function rename_referral_code(p_code_id uuid, p_new_code text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old text;
begin
  select code into v_old from referral_codes where id = p_code_id for update;
  if not found then
    raise exception 'referral code not found' using errcode = 'P0002';
  end if;
  if v_old = p_new_code then
    return v_old;
  end if;
  update referral_codes set code = p_new_code where id = p_code_id;   -- unique index raises 23505 if taken
  update users          set referred_by_code = p_new_code where referred_by_code = v_old;
  update payments       set referral_code    = p_new_code where referral_code_id = p_code_id;
  return v_old;
end;
$$;

revoke execute on function rename_referral_code(uuid, text) from public, anon, authenticated;
grant  execute on function rename_referral_code(uuid, text) to service_role;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (117, '0117_partners_section4_round40')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 117, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 117;   -- never move the version BACKWARDS (a re-run of an older file)
