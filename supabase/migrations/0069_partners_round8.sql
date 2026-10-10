-- Partners / referral, audit round 8. Idempotent - safe to re-run.
--
-- G1  Manual ledger adjustments. Until now the ledger could only hold a sale (payment_id) and the reversal
--     of a sale, so an admin had no way to claw back fraudulent commission, write off an orphan balance
--     (which blocks erasing a partner, because adminAnonymizePartner needs a zero balance) or grant a
--     goodwill bonus. An adjustment is a ledger row of its own kind: it has no payment and no code, a
--     signed amount and a mandatory reason, and it settles, voids and nets exactly like every other
--     unpaid row (payout claim, void release, balance and anonymize checks all read commission_amount_cents).
-- G3  partners.internal_notes - admin-only free text. Never selected by any token-gated partner endpoint.

alter table commission_ledger alter column payment_id drop not null;
alter table commission_ledger alter column referral_code_id drop not null;

alter table commission_ledger add column if not exists kind              text not null default 'SALE';
alter table commission_ledger add column if not exists adjustment_reason text;
alter table commission_ledger add column if not exists created_by        uuid;

alter table commission_ledger drop constraint if exists commission_ledger_kind_check;
alter table commission_ledger add constraint commission_ledger_kind_check check (kind in ('SALE', 'ADJUSTMENT'));

-- A SALE row (original or reversal) is still always tied to a payment and a code; an ADJUSTMENT never is.
alter table commission_ledger drop constraint if exists commission_ledger_kind_shape_check;
alter table commission_ledger add constraint commission_ledger_kind_shape_check check (
  (kind = 'SALE' and payment_id is not null and referral_code_id is not null)
  or
  (kind = 'ADJUSTMENT' and payment_id is null and referral_code_id is null and reverses_ledger_id is null
     and adjustment_reason is not null and commission_amount_cents <> 0)
);

alter table partners add column if not exists internal_notes text;

-- G2  Terms. terms_notified_version records which partners were emailed about the current terms version, so the
--     admin "send terms notice" action is resumable (batched) and never mails anyone twice for one version.
alter table partners add column if not exists terms_notified_version text;

-- Always the LAST statement of a migration: records how far this database has been migrated.
insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 69, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now();
