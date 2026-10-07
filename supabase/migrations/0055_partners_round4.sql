-- 0055: partners / referral program, round 4 (Section 4 deep audit).
-- Idempotent — safe to re-run. APPLY THIS BEFORE DEPLOYING the matching Worker
-- code: the Worker now reads partners.dashboard_token, payouts.internal_note and
-- partner_applications.review_note.

-- 1. Least-privilege partner links. Until now ONE bearer token (payout_details_token)
--    opened the read-only dashboard AND let its holder rewrite where payouts are sent —
--    and the dashboard link was mailed in every conversion / reversal / code email.
--    dashboard_token is READ-ONLY and is what those emails carry; payout_details_token
--    (write) is only ever mailed on its own, on request. Existing partners are backfilled
--    with a random value (64 hex chars from two v4 uuids).
alter table partners
  add column if not exists dashboard_token text;
update partners
   set dashboard_token = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
 where dashboard_token is null;
alter table partners alter column dashboard_token set not null;
create unique index if not exists partners_dashboard_token_key on partners (dashboard_token);

-- 2. What the applicant told us survives approval instead of being dropped.
alter table partners add column if not exists website  text;
alter table partners add column if not exists audience text;

-- 3. payouts.note is shown to the partner on their dashboard; the explanation an admin
--    must give for an under/overpayment is internal and had nowhere private to live.
alter table payouts add column if not exists internal_note text;

-- 4. Rejection reason (optional, also emailed to the applicant) and review history.
alter table partner_applications add column if not exists review_note text;
