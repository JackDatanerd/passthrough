-- Passthrough Experts, Phase 0A: the Human rewrite demand test (fake door).
--
-- Two NEW tables and nothing else. Nothing that exists is altered or dropped, and no function is added (so there is nothing to
-- revoke execute on). Both tables follow the posture of every other table here: row level security ON with no policy, no grant to
-- anon / authenticated, reached only by the Worker's service role.
--
--  1. human_demand_events   — one row per funnel step on the offer card: button shown, button clicked, tier selected, cover letter
--                             toggled, waitlist submitted, modal dismissed. Carries the price variant, the tier and a random,
--                             browser-held visitor id. NEVER resume text, scan contents, names, emails or any contact detail.
--  2. human_demand_waitlist — one row per person and tier ("join the waitlist"; no payment is taken). A signed-in person is
--                             identified by user_id alone (their email is not copied, so erasing the account erases the contact
--                             detail); a visitor without an account gives an email, stored lower-cased. Joining the same tier twice
--                             updates the one row (unique on identity_key + tier), so the write is idempotent.
--
-- Names are deliberately NOT the engineering spec's Phase 1 names (job_events, human_jobs ...), which are different tables.
-- Results queries live in docs/experts/phase-0a-results.sql.

create table if not exists human_demand_events (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  event         text not null check (event in ('button_shown', 'button_clicked', 'tier_selected', 'cover_letter_toggled', 'waitlist_submitted', 'modal_dismissed')),
  visitor_id    text not null check (visitor_id ~ '^[a-f0-9]{32}$'),
  price_variant text not null check (price_variant in ('low', 'base', 'high')),
  tier          text check (tier is null or tier in ('polish', 'seven_day', 'forty_eight_hour', 'twenty_four_hour')),
  cover_letter  boolean
);
create index if not exists human_demand_events_variant_event_idx on human_demand_events (price_variant, event, created_at);
create index if not exists human_demand_events_visitor_idx on human_demand_events (visitor_id);
alter table human_demand_events enable row level security;
revoke all on human_demand_events from anon, authenticated;

create table if not exists human_demand_waitlist (
  id                 uuid primary key default gen_random_uuid(),
  identity_key       text not null check (identity_key ~ '^(u:[0-9a-f-]{36}|e:[^[:space:]]{3,254})$'),
  user_id            uuid references users(id) on delete cascade,
  email              text check (email is null or (length(email) <= 254 and email = lower(email) and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')),
  tier               text not null check (tier in ('polish', 'seven_day', 'forty_eight_hour', 'twenty_four_hour')),
  cover_letter_interest boolean not null default false,
  price_variant      text not null check (price_variant in ('low', 'base', 'high')),
  quoted_cents       int not null check (quoted_cents > 0),
  cover_letter_quoted_cents int not null check (cover_letter_quoted_cents > 0),
  contact_consent    boolean not null default false,
  visitor_id         text check (visitor_id is null or visitor_id ~ '^[a-f0-9]{32}$'),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- exactly one way to reach the person: an account, or an email given without one
  check ((user_id is not null) <> (email is not null)),
  unique (identity_key, tier)
);
create index if not exists human_demand_waitlist_variant_tier_idx on human_demand_waitlist (price_variant, tier);
create index if not exists human_demand_waitlist_user_idx on human_demand_waitlist (user_id) where user_id is not null;
alter table human_demand_waitlist enable row level security;
revoke all on human_demand_waitlist from anon, authenticated;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (119, '0119_human_demand_test')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 119, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 119;   -- never move the version BACKWARDS (a re-run of an older file)
