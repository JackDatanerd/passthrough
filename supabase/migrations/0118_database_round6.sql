-- Database layer, round 6 (independent audit of the migrations + RLS posture; RLS itself was clean: every table has RLS on with no
-- policy, and anon/authenticated hold no grant on any table, sequence or function).
--
--  1. Deleting a partner failed when it had a dashboard-source terms acceptance: partner_terms_acceptances_check requires partner_id OR
--     application_email, and the FK's ON DELETE SET NULL left both empty. Those rows are only evidence of the partner's own acceptance,
--     so they go with the partner; rows that still carry an application email are kept and unlinked, as 0115/0116 intended.
--  2. grant_fix_credit_once granted a credit on EVERY call when p_round was NULL; both credit functions now refuse NULL arguments, an
--     erased account, and a scan that does not belong to the account being credited.
--  3. reattribute_sale refuses a sale that has adjustment rows ('has_adjustments') - the controller's check ran outside the transaction.
--  4. scrub_account_data matched email_logs."to" case-sensitively, so mail logged to an address typed with capitals outlived the
--     account. Matched on lower() now, with an expression index so the erase does not scan the table.
--  5. pgcrypto (0001) was created without a schema and nothing uses it. If this project put it in public its functions are reachable
--     through the API; it is moved to the extensions schema when it is in public (no-op otherwise, and never fails the migration).
--  6. Foreign keys with no covering index: scans.fix_payment_id, partner_applications.partner_id, admin_audit_log.actor_id,
--     scan_outcomes.story_moderated_by.

-- 1 -------------------------------------------------------------------------------------------------------------------------
create or replace function partners_clear_unlinkable_terms()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from partner_terms_acceptances where partner_id = old.id and application_email is null;
  return old;
end;
$$;
revoke execute on function partners_clear_unlinkable_terms() from public, anon, authenticated;

drop trigger if exists partners_clear_unlinkable_terms_trg on partners;
create trigger partners_clear_unlinkable_terms_trg
  before delete on partners
  for each row execute function partners_clear_unlinkable_terms();

-- 2 -------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.grant_fix_credit_once(p_scan_id uuid, p_user_id uuid, p_round integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_rows int;
begin
  -- A NULL round used to slip through: "fix_credit_round < NULL" is never true, but "fix_credit_round is null" is, so every
  -- call granted a credit. The credit also only goes to the account that owns the scan, and never to an erased one.
  if p_scan_id is null or p_user_id is null or p_round is null then
    return false;
  end if;
  if not exists (select 1 from users where id = p_user_id and deleted_at is null) then
    return false;
  end if;
  update scans
     set fix_credit_round = p_round
   where id = p_scan_id
     and user_id = p_user_id
     and (fix_credit_round is null or fix_credit_round < p_round);
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return false;
  end if;
  update users set free_fix_credits = free_fix_credits + 1 where id = p_user_id;
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION public.grant_upgrade_credit_once(p_scan_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_rows int;
begin
  if p_scan_id is null or p_user_id is null
     or not exists (select 1 from users where id = p_user_id and deleted_at is null) then
    return false;
  end if;
  update scans
     set upgrade_credit_granted_at = now()
   where id = p_scan_id
     and user_id = p_user_id
     and upgrade_credit_granted_at is null;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return false;
  end if;
  update users set free_fix_credits = free_fix_credits + 1 where id = p_user_id;
  return true;
end;
$function$;

revoke execute on function grant_fix_credit_once(uuid, uuid, int)    from public, anon, authenticated;
grant  execute on function grant_fix_credit_once(uuid, uuid, int)    to service_role;
revoke execute on function grant_upgrade_credit_once(uuid, uuid)     from public, anon, authenticated;
grant  execute on function grant_upgrade_credit_once(uuid, uuid)     to service_role;

-- 3 -------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reattribute_sale(p_ledger_id uuid, p_to_code_id uuid, p_to_partner_id uuid, p_rate numeric, p_commission_cents integer)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row   commission_ledger%rowtype;
  v_code  text;
  v_limit int;
  v_uses  int;
begin
  select * into v_row from commission_ledger where id = p_ledger_id for update;
  if not found then return 'not_found'; end if;
  if v_row.kind <> 'SALE' or v_row.reverses_ledger_id is not null or v_row.payment_id is null then
    return 'not_a_sale';
  end if;
  if v_row.payout_id is not null then return 'already_paid'; end if;
  if exists (select 1 from commission_ledger where reverses_ledger_id = p_ledger_id) then
    return 'already_reversed';
  end if;
  -- Partial-refund and admin adjustments hang off this sale by adjusts_ledger_id and stay with the partner they were made against.
  -- Moving the sale underneath them would leave the old partner charged for a sale that is no longer theirs. The controller checks
  -- this too, but outside this transaction - an adjustment landing in between slipped through. The check belongs where the lock is.
  if exists (select 1 from commission_ledger where adjusts_ledger_id = p_ledger_id) then
    return 'has_adjustments';
  end if;
  if v_row.referral_code_id = p_to_code_id then return 'same_code'; end if;

  select code, usage_limit, uses_so_far into v_code, v_limit, v_uses
    from referral_codes where id = p_to_code_id and partner_id = p_to_partner_id for update;
  if v_code is null then return 'target_not_found'; end if;

  if v_row.usage_counted then
    if v_limit is not null and v_uses >= v_limit then return 'target_exhausted'; end if;
    update referral_codes set uses_so_far = greatest(uses_so_far - 1, 0) where id = v_row.referral_code_id;
    update referral_codes set uses_so_far = uses_so_far + 1 where id = p_to_code_id;
  end if;

  update commission_ledger
     set partner_id = p_to_partner_id,
         referral_code_id = p_to_code_id,
         commission_rate = p_rate,
         commission_amount_cents = p_commission_cents,
         attribution_sub = null
   where id = p_ledger_id;

  update payments
     set referral_code_id = p_to_code_id,
         referral_code = v_code,
         referral_sub = null,
         referral_commission_rate = p_rate
   where id = v_row.payment_id;

  return 'ok';
end;
$function$;

revoke execute on function reattribute_sale(uuid, uuid, uuid, numeric, int) from public, anon, authenticated;
grant  execute on function reattribute_sale(uuid, uuid, uuid, numeric, int) to service_role;

-- 4 -------------------------------------------------------------------------------------------------------------------------
create index if not exists idx_email_logs_to_lower on email_logs (lower("to"));

CREATE OR REPLACE FUNCTION public.scrub_account_data(p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_old_email     text;
  v_pending_email text;
  v_placeholder   text := 'deleted-' || p_user_id || '@passthrough.dev';
  r               record;
begin
  select email, pending_email into v_old_email, v_pending_email from users where id = p_user_id;

  -- The page links and file fingerprints this account published outlive it as tombstones (0036 / 0049).
  -- Done FIRST, in this same transaction: the columns are nulled below, so a failure after that point can no
  -- longer be recovered from.
  for r in
    select verification_code, resume_hash, resume_pdf_hash, resume_hash_history
      from scans where user_id = p_user_id and verification_code is not null
  loop
    perform write_verification_tombstone(r.verification_code, r.resume_hash, r.resume_pdf_hash, r.resume_hash_history);
  end loop;

  update scans set
    resume_path                  = null,
    resume_ats_path               = null,
    resume_pdf_path                = null,
    resume_original_name           = null,
    resume_hash                    = null,
    resume_pdf_hash                = null,
    resume_hash_history            = '[]'::jsonb,
    job_description_text           = null,
    job_description_url            = null,
    job_title                      = null,
    candidate_first_name           = null,
    cover_letter_text              = null,
    raw_brain_dump_text            = null,
    original_resume_data           = null,
    rewritten_resume_data          = null,
    quantification_prompts         = null,
    user_edited_resume_data        = null,
    fix_ats_report                 = null,
    full_ats_report                = null,
    verification_code              = null,
    verification_url               = null,
    verify_expose_docx             = false,
    verify_expose_pdf              = false,
    verify_hide_name                = false,
    verification_status             = 'ACTIVE',
    verification_revoked_at         = null,
    verification_revoked_reason     = null,
    fix_payment_id                  = null,
    contact_name                    = null,
    contact_email                   = null
  where user_id = p_user_id;

  -- Homepage outcomes (0070): the story is personal text and the credential link points at a page this
  -- same function just disabled, so both go. The outcome ANSWER itself stays, anonymised.
  update scan_outcomes set
    story_consent         = false,
    story_status          = 'NONE',
    story_display_name    = null,
    story_quote           = null,
    story_text            = null,
    story_show_credential = false
  where user_id = p_user_id;

  -- email_logs has no user_id column — "to" (the address) is the only link, captured above before the users
  -- row below overwrites it. An unconfirmed pending address was mailed too (the confirmation link).
  if v_old_email is not null then
    update email_logs set "to" = v_placeholder where lower("to") = lower(v_old_email);
  end if;
  if v_pending_email is not null and v_pending_email is distinct from v_old_email then
    update email_logs set "to" = v_placeholder where lower("to") = lower(v_pending_email);
  end if;

  -- Auth sessions (0047) carry the sign-in IP and user-agent.
  delete from user_sessions where user_id = p_user_id;

  -- Additional saved profiles (0067) hold the same resume PII as users.saved_profile.
  delete from saved_profiles where user_id = p_user_id;

  update users set
    deleted_at              = coalesce(deleted_at, now()),
    email                    = v_placeholder,
    name                     = 'Deleted User',
    password_hash            = 'deleted',
    saved_profile            = null,
    saved_profile_prev       = null,
    token_version            = token_version + 1,
    reset_token              = null,
    reset_token_expiry       = null,
    email_verify_token       = null,
    email_verify_expiry      = null,
    pending_email            = null,
    pending_email_token      = null,
    pending_email_expiry     = null,
    last_login_at            = null,
    last_login_ip            = null,
    previous_login_at        = null,
    previous_login_ip        = null,
    last_login_alert_at      = null,
    email_change_done_token  = null,
    referred_by_code         = null,
    referred_at              = null,
    referred_sub             = null
  where id = p_user_id;
end;
$function$;

revoke execute on function scrub_account_data(uuid) from public, anon, authenticated;
grant  execute on function scrub_account_data(uuid) to service_role;

-- 5 -------------------------------------------------------------------------------------------------------------------------
do $$
declare
  v_schema text;
begin
  select n.nspname into v_schema
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'pgcrypto';
  if v_schema = 'public' then
    if exists (select 1 from pg_namespace where nspname = 'extensions') then
      alter extension pgcrypto set schema extensions;
    else
      raise notice 'pgcrypto is installed in public and there is no extensions schema to move it to; drop it if nothing of yours uses it';
    end if;
  end if;
exception when others then
  raise notice 'pgcrypto was not moved out of public: %', sqlerrm;
end $$;

-- 6 -------------------------------------------------------------------------------------------------------------------------
create index if not exists idx_scans_fix_payment_id            on scans (fix_payment_id)              where fix_payment_id is not null;
create index if not exists idx_partner_applications_partner_id on partner_applications (partner_id)   where partner_id is not null;
create index if not exists idx_admin_audit_log_actor_id        on admin_audit_log (actor_id)          where actor_id is not null;
create index if not exists idx_scan_outcomes_story_moderated_by on scan_outcomes (story_moderated_by) where story_moderated_by is not null;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (118, '0118_database_round6')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 118, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 118;   -- never move the version BACKWARDS (a re-run of an older file)
