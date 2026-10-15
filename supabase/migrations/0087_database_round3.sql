-- Database layer (Section 10), independent audit round 3. Idempotent — safe to re-run.
--
-- Apply BEFORE deploying the Worker (the Worker also checks the schema version and the migration ledger this records).
-- ORDER NOTE: section 1 moves partner payout links to a hashed column. A Worker still running the previous code cannot
-- authenticate a payout link between this migration and the deploy — keep that window short.
--
-- 1. partners.payout_details_token was stored in clear. It is the WRITE capability of the partner programme (whoever holds it can
--    change where a payout is sent), and every other bearer token in this schema (reset, email-verify, email-change, anon scan,
--    0045) is stored as a sha256. payout_token_hash now holds sha256(token); existing links keep working because the Worker
--    hashes the token a visitor presents. The raw column is emptied and made nullable. (dashboard_token stays as it is: it is a
--    read-only link that every conversion email re-sends.) "Resend the payout link" therefore issues a NEW link — the old one
--    can no longer be shown to anyone.
--
-- 2. record_payout_settlement / void_payout — recording and voiding a payout were several separate PostgREST calls
--    (insert the payout, claim the ledger rows, compensate by hand if the claim fell short or failed; mark void, then release the
--    rows). The compensation code was long, and a failure inside it left a payout whose commission was still "owed" (or the
--    reverse). Each is now ONE transaction under a lock on the partner row. Same pattern as scrub_account_data and
--    record_refund_and_total.
--
-- 3. Saved-profile RPCs wrote NULL over a whole profile when handed a NULL resume / NULL edit stamp (jsonb_set is strict, so the
--    result was NULL and the function still answered "true"). They now refuse such input. The Worker never sends it; the point
--    is that a security-definer function must not be able to erase a profile by being called wrongly.
--
-- 4. admin_audit_log is described as append-only but nothing enforced it (service_role bypasses RLS, not triggers). A trigger now
--    refuses UPDATE and DELETE. (The only change it lets through is the ON DELETE SET NULL the actor_id foreign key performs.)
--
-- 5. referral_codes.code is "always upper-case" by convention only. A CHECK now holds it, the same step 0017 / 0038 took for e-mail.
--
-- 6. saved_profiles.source_scan_id had no foreign key and users.saved_profile / saved_profile_prev keep the same pointer inside
--    jsonb, so deleting a scan relied on every caller remembering clear_saved_profile_source. A foreign key (ON DELETE SET NULL) and
--    a BEFORE DELETE trigger on scans now clear all three pointers whatever path deletes the scan.

-- ── 1. hashed payout token ───────────────────────────────────────────────────

alter table partners add column if not exists payout_token_hash text;

update partners
   set payout_token_hash = encode(sha256(convert_to(payout_details_token, 'utf8')), 'hex')
 where payout_token_hash is null
   and payout_details_token is not null;

alter table partners alter column payout_details_token drop not null;
update partners set payout_details_token = null where payout_details_token is not null;

create unique index if not exists partners_payout_token_hash_key
  on partners (payout_token_hash) where payout_token_hash is not null;

-- ── 2. atomic payout recording / voiding ─────────────────────────────────────

-- p_payout: { amount_cents, currency, payout_method, payout_details_snapshot, settled_commission_cents, note, internal_note,
--             period_start, period_end }.
-- p_discard_if_empty: the amount was "what is owed" and this call won no ledger row (a concurrent payout settled them all) —
--                     record nothing at all.
-- p_amount_is_auto:   the amount was omitted by the caller; on a shortfall it is corrected down to what was really settled.
-- Returns { payout, requested, claimed, claimed_cents, discarded }.
create or replace function record_payout_settlement(
  p_partner_id        uuid,
  p_ledger_ids        uuid[],
  p_payout            jsonb,
  p_discard_if_empty  boolean default false,
  p_amount_is_auto    boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id            uuid := gen_random_uuid();
  v_requested     int  := coalesce(cardinality(p_ledger_ids), 0);
  v_claimed       int  := 0;
  v_claimed_cents bigint := 0;
  v_row           payouts%rowtype;
begin
  if p_payout is null or jsonb_typeof(p_payout) <> 'object' then
    raise exception 'record_payout_settlement: p_payout must be a JSON object' using errcode = '22023';
  end if;

  -- Serialises every payout recording / void for ONE partner.
  perform 1 from partners where id = p_partner_id for update;
  if not found then
    raise exception 'record_payout_settlement: partner % not found', p_partner_id using errcode = 'P0002';
  end if;

  insert into payouts (id, partner_id, amount_cents, currency, payout_method, payout_details_snapshot,
                       settled_commission_cents, note, internal_note, period_start, period_end)
  values (v_id, p_partner_id,
          (p_payout ->> 'amount_cents')::int,
          coalesce(p_payout ->> 'currency', 'USD'),
          (p_payout ->> 'payout_method')::payout_method_enum,
          coalesce(p_payout -> 'payout_details_snapshot', '{}'::jsonb),
          (p_payout ->> 'settled_commission_cents')::int,
          p_payout ->> 'note',
          p_payout ->> 'internal_note',
          (p_payout ->> 'period_start')::date,
          (p_payout ->> 'period_end')::date);

  if v_requested > 0 then
    with won as (
      update commission_ledger
         set payout_id = v_id
       where id = any (p_ledger_ids)
         and partner_id = p_partner_id
         and payout_id is null
      returning commission_amount_cents)
    select count(*)::int, coalesce(sum(commission_amount_cents), 0) into v_claimed, v_claimed_cents from won;

    if v_claimed < v_requested then
      if p_discard_if_empty and v_claimed = 0 then
        delete from payouts where id = v_id;
        return jsonb_build_object('payout', null, 'requested', v_requested, 'claimed', 0, 'claimed_cents', 0, 'discarded', true);
      end if;
      update payouts
         set settled_commission_cents = v_claimed_cents,
             -- payouts_amount_cents_nonnegative (0031): a net-negative claim keeps the figure that was typed in.
             amount_cents = case when p_amount_is_auto and v_claimed_cents >= 0 then v_claimed_cents else amount_cents end
       where id = v_id;
    end if;
  end if;

  select * into v_row from payouts where id = v_id;
  return jsonb_build_object('payout', to_jsonb(v_row), 'requested', v_requested, 'claimed', v_claimed,
                            'claimed_cents', v_claimed_cents, 'discarded', false);
end;
$$;

-- Marks a payout void and releases the ledger rows it settled, in one transaction. Safe to call again on an already-void payout
-- (it only re-releases). Returns { already_voided, released } or NULL when the payout does not exist for that partner.
create or replace function void_payout(p_payout_id uuid, p_partner_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_voided_at timestamptz;
  v_already   boolean;
  v_released  int;
begin
  perform 1 from partners where id = p_partner_id for update;
  select voided_at into v_voided_at from payouts where id = p_payout_id and partner_id = p_partner_id for update;
  if not found then
    return null;
  end if;
  v_already := v_voided_at is not null;
  if not v_already then
    update payouts set voided_at = now(), void_reason = p_reason where id = p_payout_id;
  end if;
  with released as (
    update commission_ledger set payout_id = null where payout_id = p_payout_id returning id)
  select count(*)::int into v_released from released;
  return jsonb_build_object('already_voided', v_already, 'released', v_released);
end;
$$;

revoke execute on function record_payout_settlement(uuid, uuid[], jsonb, boolean, boolean) from public, anon, authenticated;
grant  execute on function record_payout_settlement(uuid, uuid[], jsonb, boolean, boolean) to service_role;
revoke execute on function void_payout(uuid, uuid, text) from public, anon, authenticated;
grant  execute on function void_payout(uuid, uuid, text) to service_role;

-- ── 3. saved-profile RPCs refuse input that would erase a profile ─────────────

create or replace function set_saved_profile_resume(
  p_user_id uuid, p_resume jsonb, p_edited_at timestamptz, p_expected_version text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  if p_resume is null or jsonb_typeof(p_resume) <> 'object' or p_edited_at is null then
    raise exception 'set_saved_profile_resume: p_resume (a JSON object) and p_edited_at are required' using errcode = '22004';
  end if;
  update users
     set saved_profile_prev = case
           when (saved_profile -> 'resumeData') is distinct from p_resume
           then saved_profile || jsonb_build_object('replacedAt', now())
           else saved_profile_prev end,
         saved_profile = case
           when (saved_profile -> 'resumeData') is distinct from p_resume
           then jsonb_set(
                  jsonb_set(saved_profile, '{resumeData}', p_resume),
                  '{editedAt}', to_jsonb(p_edited_at))
           else saved_profile end
   where id = p_user_id
     and saved_profile is not null
     and saved_profile ? 'resumeData'
     and (p_expected_version is null
          or (coalesce(saved_profile ->> 'savedAt', '') || '|' || coalesce(saved_profile ->> 'editedAt', ''))
             = p_expected_version);
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

create or replace function update_saved_profile(p_user_id uuid, p_id uuid, p_resume jsonb, p_label text, p_expected_version timestamptz, p_edited_at timestamptz)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  if p_resume is not null and (jsonb_typeof(p_resume) <> 'object' or p_edited_at is null) then
    raise exception 'update_saved_profile: a resume must be a JSON object and come with p_edited_at' using errcode = '22004';
  end if;
  update saved_profiles
     set resume_data = coalesce(p_resume, resume_data),
         label       = coalesce(p_label, label),
         edited_at   = case
                         when p_resume is null or p_resume is not distinct from resume_data then edited_at
                         else p_edited_at end
   where id = p_id and user_id = p_user_id
     and (p_expected_version is null or coalesce(edited_at, saved_at) = p_expected_version);
  get diagnostics v_rows = row_count;
  if v_rows > 0 then return 'ok'; end if;
  if exists (select 1 from saved_profiles where id = p_id and user_id = p_user_id) then return 'conflict'; end if;
  return 'missing';
end;
$$;

create or replace function save_profile_from_scan(p_user_id uuid, p_profile jsonb, p_replace_edited boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  if p_profile is null or jsonb_typeof(p_profile) <> 'object' then
    raise exception 'save_profile_from_scan: p_profile must be a JSON object' using errcode = '22004';
  end if;
  update users
     set saved_profile_prev = case
           when saved_profile is not null and saved_profile ? 'resumeData'
                and (saved_profile -> 'resumeData') is distinct from (p_profile -> 'resumeData')
           then saved_profile || jsonb_build_object('replacedAt', now())
           else saved_profile_prev end,
         saved_profile = p_profile
   where id = p_user_id
     and (p_replace_edited
          or saved_profile is null
          or not (saved_profile ? 'editedAt'));
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke execute on function set_saved_profile_resume(uuid, jsonb, timestamptz, text) from public, anon, authenticated;
grant  execute on function set_saved_profile_resume(uuid, jsonb, timestamptz, text) to service_role;
revoke execute on function update_saved_profile(uuid, uuid, jsonb, text, timestamptz, timestamptz) from public, anon, authenticated;
grant  execute on function update_saved_profile(uuid, uuid, jsonb, text, timestamptz, timestamptz) to service_role;
revoke execute on function save_profile_from_scan(uuid, jsonb, boolean) from public, anon, authenticated;
grant  execute on function save_profile_from_scan(uuid, jsonb, boolean) to service_role;

-- ── 4. admin_audit_log is append-only ────────────────────────────────────────

create or replace function admin_audit_log_append_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.actor_id is null
     and (to_jsonb(new) - 'actor_id') = (to_jsonb(old) - 'actor_id') then
    return new;   -- the ON DELETE SET NULL of the actor_id foreign key
  end if;
  raise exception 'admin_audit_log is append-only (% refused)', tg_op using errcode = '42501';
end;
$$;

revoke execute on function admin_audit_log_append_only() from public, anon, authenticated;

drop trigger if exists admin_audit_log_append_only_trg on admin_audit_log;
create trigger admin_audit_log_append_only_trg
  before update or delete on admin_audit_log
  for each row execute function admin_audit_log_append_only();

-- ── 5. referral code casing ──────────────────────────────────────────────────

do $$
begin
  if exists (select 1 from referral_codes group by upper(code) having count(*) > 1) then
    raise exception 'referral_codes holds codes that differ only by case — merge or rename them first: select upper(code), array_agg(id) from referral_codes group by 1 having count(*) > 1';
  end if;
  update referral_codes set code = upper(code) where code <> upper(code);
  if not exists (select 1 from pg_constraint where conname = 'referral_codes_code_upper_chk') then
    alter table referral_codes add constraint referral_codes_code_upper_chk check (code = upper(code));
  end if;
end $$;

-- ── 6. saved-profile source-scan pointers follow the scan ────────────────────

update saved_profiles sp set source_scan_id = null
 where source_scan_id is not null and not exists (select 1 from scans s where s.id = sp.source_scan_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'saved_profiles_source_scan_id_fkey') then
    alter table saved_profiles
      add constraint saved_profiles_source_scan_id_fkey
      foreign key (source_scan_id) references scans(id) on delete set null;
  end if;
end $$;

create index if not exists idx_saved_profiles_source_scan
  on saved_profiles (source_scan_id) where source_scan_id is not null;

create or replace function scans_clear_profile_pointers()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.user_id is not null then
    update users
       set saved_profile = jsonb_set(saved_profile, '{sourceScanId}', 'null'::jsonb)
     where id = old.user_id
       and saved_profile is not null
       and saved_profile ->> 'sourceScanId' = old.id::text;
    update users
       set saved_profile_prev = jsonb_set(saved_profile_prev, '{sourceScanId}', 'null'::jsonb)
     where id = old.user_id
       and saved_profile_prev is not null
       and saved_profile_prev ->> 'sourceScanId' = old.id::text;
  end if;
  return old;
end;
$$;

revoke execute on function scans_clear_profile_pointers() from public, anon, authenticated;

drop trigger if exists scans_clear_profile_pointers_trg on scans;
create trigger scans_clear_profile_pointers_trg
  before delete on scans
  for each row execute function scans_clear_profile_pointers();

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (87, '0087_database_round3')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 87, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 87;   -- never move the version BACKWARDS (a re-run of an older file)
