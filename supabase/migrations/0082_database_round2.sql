-- Database layer (Section 10), independent audit round 2. Idempotent — safe to re-run.
--
-- Apply BEFORE deploying the Worker (the Worker also checks the schema version and the migration ledger this records).
--
-- 1. Table privileges. RLS (0014) was the ONLY thing between the `anon` / `authenticated` roles and every table: on Supabase
--    those roles hold full table privileges by default, and only two tables ever revoked them (0046, 0051). A table that
--    shipped without RLS was therefore wide open — 0044 created referral_code_reservations that way and it stayed exposed
--    until 0046. 0023/0077 closed the same shape of gap for FUNCTIONS; this closes it for tables and sequences, and makes
--    "reachable by a client role" an explicit opt-in for every table created from here on. service_role (the Worker) is
--    untouched and bypasses RLS as before. It is done FIRST so the table created in section 5 is born without them.
--
-- 2. Three foreign keys had no supporting index:
--      payments.referral_reservation_id  ON DELETE SET NULL — every reservation delete (checkout released, consumed,
--                                         hourly prune) scanned the whole payments table to null the reference.
--      commission_ledger.payout_id        voiding a payout and the per-payout ledger filter did `where payout_id = ?`;
--                                         the only index on the column is the partial `where payout_id is null`.
--      commission_ledger.referral_code_id the same, per code.
--    Partial (`is not null`) because most rows hold NULL; an equality lookup implies NOT NULL, so Postgres still uses them.
--
-- 3. scrub_account_data (the TENTH definition; 0077's body is the base, nothing it covered is dropped):
--      + users.referred_by_code / referred_at (0079) — which partner's link the person arrived through; added without
--        touching the scrub, the exact regression 0026 made against 0025.
--      + deleted_at keeps its ORIGINAL value on a second run (claimScan's re-scrub, a retried delete) instead of moving
--        forward each time. token_version still bumps, so any token issued meanwhile dies.
--
-- 4. lead_mailbox_key() was described as a line-for-line port of canonicalMailbox() but btrim() only strips spaces while
--    JS trim() strips every whitespace character, so "a@b.com\n" and "a@b.com" got different keys in SQL and the same one
--    in JS. Trimming now matches. (Non-ASCII case folding, e.g. dotted capital I, still follows the database collation and
--    is outside the parity the fixtures cover.)
--
-- 5. applied_migrations — a ledger. schema_version is ONE integer, so a skipped migration is invisible as soon as a later one
--    is applied (the numbering test says so itself). From 0082 on every migration records its own row here and the health
--    check (src/lib/health.js) fails when any version from 82 up to the expected one is missing.

-- ── 1. table privileges ──────────────────────────────────────────────────────

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- ── 2. foreign-key indexes ───────────────────────────────────────────────────

create index if not exists idx_payments_referral_reservation
  on payments (referral_reservation_id) where referral_reservation_id is not null;
create index if not exists idx_commission_ledger_payout
  on commission_ledger (payout_id) where payout_id is not null;
create index if not exists idx_commission_ledger_referral_code
  on commission_ledger (referral_code_id) where referral_code_id is not null;

-- ── 3. scrub_account_data ────────────────────────────────────────────────────

create or replace function scrub_account_data(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
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
    update email_logs set "to" = v_placeholder where "to" = v_old_email;
  end if;
  if v_pending_email is not null and v_pending_email is distinct from v_old_email then
    update email_logs set "to" = v_placeholder where "to" = v_pending_email;
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
    referred_at              = null
  where id = p_user_id;
end;
$$;

-- CREATE OR REPLACE keeps the grants 0023 set; restated so this file reads on its own.
revoke execute on function scrub_account_data(uuid) from public, anon, authenticated;
grant  execute on function scrub_account_data(uuid) to service_role;

-- ── 4. lead_mailbox_key: trim exactly what JS trim() trims ───────────────────

create or replace function lead_mailbox_key(p_email text)
returns text
language plpgsql
immutable
as $$
declare
  e       text := lower(regexp_replace(coalesce(p_email, ''),
                   '^[ \t\n\v\f\r   -     　﻿]+|[ \t\n\v\f\r   -     　﻿]+$',
                   '', 'g'));
  at_pos  int;
  loc     text;
  dom     text;
  plus    int;
begin
  -- Position (1-based) of the LAST '@'. Anything without one, or that starts with it, is returned unchanged.
  at_pos := length(e) - position('@' in reverse(e)) + 1;
  if position('@' in e) = 0 or at_pos < 2 then
    return e;
  end if;
  loc := left(e, at_pos - 1);
  dom := substr(e, at_pos + 1);
  plus := position('+' in loc);
  if plus > 1 then
    loc := left(loc, plus - 1);
  end if;
  if dom in ('gmail.com', 'googlemail.com') then
    loc := replace(loc, '.', '');
    dom := 'gmail.com';
  end if;
  if loc = '' then
    return e;
  end if;
  return loc || '@' || dom;
end;
$$;

revoke execute on function lead_mailbox_key(text) from public, anon, authenticated;
grant  execute on function lead_mailbox_key(text) to service_role;

-- Rows whose stored key was built with the old trim. (Not touching updated_at: it is mergeIntoExistingLead's token.)
update employer_leads set mailbox_key = lead_mailbox_key(email)
 where mailbox_key is distinct from lead_mailbox_key(email);

-- ── 5. migration ledger ──────────────────────────────────────────────────────

create table if not exists applied_migrations (
  version     int         primary key,
  name        text        not null,
  applied_at  timestamptz not null default now()
);
alter table applied_migrations enable row level security;   -- service role only, like every table (0014)
revoke all on applied_migrations from anon, authenticated;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (82, '0082_database_round2')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 82, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now();
