-- Referral-code discount pricing + commission ledger. Builds on
-- 0011_partners_and_payouts.sql. This is the piece that makes a referral
-- code actually change what gets charged, not just what gets displayed:
-- pricing.controller.js (the quote) and payments.controller.js (the charge)
-- both resolve price through services/referral.service.js, which is the
-- only thing that ever reads this table — same single-source-of-truth
-- discipline config/constants.js's promo pricing already follows.

alter table partners add column commission_rate numeric(5,4) not null default 0.25;
-- Fraction, not a percentage integer (0.25 = 25%) — avoids any ambiguity
-- at the multiplication site in referral.service.js.

create table referral_codes (
  id           uuid primary key default gen_random_uuid(),
  partner_id   uuid not null references partners(id),
  code         text not null unique,     -- always stored upper-cased (see referral.service.js)
  -- {"FIX": 1900, "BADGE": 900, "FIX_PLAIN": 900} — cents, per tier. A tier
  -- absent from this object simply isn't discounted for this code; the
  -- normal promo/standard price applies to it instead.
  tier_prices  jsonb not null,
  active       boolean not null default true,
  usage_limit  int,                       -- null = unlimited
  uses_so_far  int not null default 0,    -- successful REDEMPTIONS (paid), not clicks
  clicks       int not null default 0,    -- link visits — see increment_referral_code_clicks below
  expires_at   timestamptz,
  created_at   timestamptz not null default now()
);

create index referral_codes_partner_idx on referral_codes(partner_id);

-- Referral attribution, bound to the payment row exactly like fix_tier is
-- (see payments.controller.js's tier-smuggling comment): whatever code
-- priced THIS payment stays true for it forever, regardless of what
-- happens to the code afterward (deactivated, edited, deleted).
alter table payments add column referral_code_id uuid references referral_codes(id);
alter table payments add column referral_code    text;  -- denormalized snapshot of the code string

create table commission_ledger (
  id                       uuid primary key default gen_random_uuid(),
  payment_id               uuid not null unique references payments(id),
  -- unique on payment_id: one ledger row per payment, ever. Also the
  -- backstop against double-crediting if recordConversion() were ever
  -- accidentally called twice for the same payment — see referral.service.js.
  partner_id               uuid not null references partners(id),
  referral_code_id         uuid not null references referral_codes(id),
  gross_amount_cents       int not null,
  commission_rate          numeric(5,4) not null,  -- snapshot of partner.commission_rate AT THE TIME
  commission_amount_cents  int not null,
  -- Set once this commission has been included in a recorded payout
  -- (partners.controller.js's adminRecordPayout). Null = still owed.
  payout_id                uuid references payouts(id),
  created_at               timestamptz not null default now()
);

create index commission_ledger_partner_idx on commission_ledger(partner_id);
create index commission_ledger_unpaid_idx  on commission_ledger(partner_id) where payout_id is null;

-- Atomic increment for uses_so_far. A plain read-then-write from
-- application code risks a lost update under concurrent redemptions of the
-- same code; wrapping the arithmetic in one SQL statement makes the counter
-- itself exact. (The usage_limit CHECK that happens beforehand in
-- referral.service.js can still race in the same benign way
-- middleware/rateLimiter.js's KV counter does — acceptable for a marketing
-- usage cap, not something this counter's own correctness depends on.)
create or replace function increment_referral_code_usage(p_code_id uuid)
returns void
language sql
as $$
  update referral_codes set uses_so_far = uses_so_far + 1 where id = p_code_id;
$$;

-- Same reasoning for click counts — best-effort, high-volume, no financial
-- consequence if a couple of concurrent clicks land as one.
create or replace function increment_referral_code_clicks(p_code text)
returns void
language sql
as $$
  update referral_codes set clicks = clicks + 1 where code = p_code;
$$;
