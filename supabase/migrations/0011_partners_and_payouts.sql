-- Partners (affiliates) + manual payout tracking.
--
-- Scope, deliberately: this is the MANUAL-payout version. There is no
-- automated disbursement here — an admin sends money themselves outside
-- this system (bank app / mobile money app), then records what they sent
-- via POST /api/partners/:id/payouts, which stamps a PAID row and emails
-- the partner a confirmation. Referral-code discount PRICING (a separate,
-- larger feature — see the growth-strategy build scope) is intentionally
-- NOT part of this migration.

create type partner_status_enum as enum ('ACTIVE', 'PAUSED');
create type payout_method_enum  as enum ('BANK', 'MOBILE_MONEY');
create type payout_status_enum  as enum ('PAID');
-- Only PAID exists for now — a payout row is only ever created after the
-- admin has already sent the money. If a "pending/approved" workflow is
-- added later (see build scope), extend this enum then; don't pre-build
-- states nothing in the app can produce yet.

create table partners (
  id                           uuid primary key default gen_random_uuid(),
  name                         text not null,
  email                        text not null,
  referral_code                text unique,           -- optional label for now; not wired to pricing yet
  status                       partner_status_enum not null default 'ACTIVE',
  -- Long random token mailed to the partner as a link (?token=...) so they
  -- can submit/update their own payout details without a full login system.
  -- Not time-limited: they may need to update bank details later, and the
  -- token is 32 random bytes (crypto.getRandomValues), not guessable.
  payout_details_token         text unique not null,
  payout_method                payout_method_enum,
  -- Shape depends on payout_method — {bankName, accountName, accountNumber}
  -- for BANK, {provider, accountName, phoneNumber} for MOBILE_MONEY. Kept
  -- schemaless here (validated by zod at the API boundary in
  -- partners.controller.js) since the two shapes genuinely differ and a
  -- rigid column set would just be nullable-everything.
  payout_details               jsonb,
  payout_details_submitted_at  timestamptz,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);

create index partners_status_idx on partners(status);

create table payouts (
  id                       uuid primary key default gen_random_uuid(),
  partner_id               uuid not null references partners(id),
  amount_cents             int not null,
  currency                 text not null default 'USD',
  payout_method            payout_method_enum not null,
  -- Snapshot of partner.payout_details AT THE MOMENT this payout was
  -- recorded. Partner details can change later (they update their bank
  -- account); the historical record of what was actually paid where must
  -- not silently change retroactively when they do.
  payout_details_snapshot  jsonb not null,
  note                     text,
  status                   payout_status_enum not null default 'PAID',
  paid_at                  timestamptz not null default now(),
  created_at               timestamptz not null default now()
);

create index payouts_partner_idx on payouts(partner_id);
