-- AUDIT FIX (Section 10 — Database layer / RLS audit).
--
-- 0001_init.sql's original reasoning for leaving RLS off: "there is no
-- direct client-to-Supabase path — every read/write goes through this
-- Worker using the service_role key, which bypasses RLS regardless." That
-- precondition genuinely holds (verified: no Supabase client, anon key, or
-- project URL exists anywhere in frontend/ or anywhere else in this repo).
--
-- But the reasoning frames the risk as "do we ever add a browser-to-
-- Supabase code path in THIS app." That's not the actual threat model.
-- Supabase auto-exposes every table in the `public` schema over its
-- PostgREST REST API to both the `anon` and `authenticated` roles the
-- moment RLS is off, independent of whether this specific frontend ever
-- uses that key — it's a property of the Supabase project, not of this
-- codebase. The anon key isn't treated as secret the way service_role is
-- (Supabase's own onboarding tells you to embed it in frontend JS); the
-- entire reason RLS exists is to make an anon-key leak a non-event. With
-- RLS off everywhere, an anon-key leak here — via git history, a support
-- screenshot, a future contractor wiring up a client "the normal way,"
-- anyone with dashboard access — is not a non-event: it's unauthenticated
-- read/write access to `users` (password hashes included) and every other
-- table, via an endpoint that requires zero code in this repo at all.
--
-- The fix costs nothing and changes zero application behavior:
-- `enable row level security` with NO policies defined makes PostgREST
-- deny all access to `anon`/`authenticated` by default. `service_role`
-- continues to bypass RLS entirely regardless of policies — that's what
-- service_role means — so every existing Supabase call this Worker makes
-- (all of them via getSupabase(), all using the service_role key) keeps
-- working exactly as before. This migration only removes the previously-
-- unguarded anon/authenticated path; it adds no policies because none are
-- needed yet — the day a genuine browser-to-Supabase path is added (per
-- 0001's own trigger condition), real policies scoped to that use case
-- should be written then, not preemptively guessed at now.
--
-- Idempotent: `enable row level security` is safe to re-run against a
-- table that already has it enabled.

alter table users              enable row level security;
alter table scans              enable row level security;
alter table payments           enable row level security;
alter table employer_leads     enable row level security;
alter table email_logs         enable row level security;
alter table partners           enable row level security;
alter table payouts            enable row level security;
alter table referral_codes     enable row level security;
alter table commission_ledger  enable row level security;
