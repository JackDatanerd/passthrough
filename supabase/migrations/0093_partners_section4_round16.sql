-- Partners / referral programme, Section 4 round 16.
--
-- 1. Channel tags (feature gap). A partner can append `&sub=newsletter` to a share link and see which placement earned each sale.
--    The tag travels like the attribution source (0079): browser -> POST /payments/initialize -> payments.referral_sub ->
--    commission_ledger.attribution_sub. It is a short label the partner chose (lower-case letters, digits, `_`, `-`, 1-32 chars),
--    enforced here as well as in the application (lib/referralSub.js). Nullable: every existing row, and every sale from a link
--    without a tag, simply has none.
-- 2. admin_audit_log scrub. 'partner.referral_code_created' / 'partner.referral_code_updated' used to store the code TEXT in
--    `detail`. A code is often a person's name (ANNA20), and the erasure flow renames codes to REMOVED-xxxx — but this append-only
--    log kept the original text, so an erased partner's code survived there. The code is replaced by the id of the code row, which is
--    what the application now writes (`detail` is for ids and field names, never what a person typed).
--    The log is append-only by trigger (0087 / 0091); the scrub switches that trigger off for exactly this one statement, inside this
--    migration's transaction, and switches it back on.

-- ── 1. channel tags ──────────────────────────────────────────────────────────

alter table payments          add column if not exists referral_sub    text;
alter table commission_ledger add column if not exists attribution_sub text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payments_referral_sub_check') then
    alter table payments add constraint payments_referral_sub_check
      check (referral_sub is null or referral_sub ~ '^[a-z0-9_-]{1,32}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'commission_ledger_attribution_sub_check') then
    alter table commission_ledger add constraint commission_ledger_attribution_sub_check
      check (attribution_sub is null or attribution_sub ~ '^[a-z0-9_-]{1,32}$');
  end if;
end $$;

-- ── 2. code text out of the audit log ────────────────────────────────────────

alter table admin_audit_log disable trigger admin_audit_log_append_only_trg;

update admin_audit_log
   set detail = (detail - 'code') || case when detail ? 'codeId' or target_id is null then '{}'::jsonb
                                          else jsonb_build_object('codeId', target_id) end
 where action in ('partner.referral_code_created', 'partner.referral_code_updated')
   and jsonb_typeof(detail) = 'object'
   and detail ? 'code';

alter table admin_audit_log enable trigger admin_audit_log_append_only_trg;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (93, '0093_partners_section4_round16')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 93, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 93;   -- never move the version BACKWARDS (a re-run of an older file)
