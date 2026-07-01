-- Passthrough — initial schema
-- Translated 1:1 from the v8 Prisma schema. cuid() -> uuid via gen_random_uuid().
-- Run via: supabase db push   OR   paste into the Supabase SQL Editor.

create extension if not exists pgcrypto;

-- ── Enums ──────────────────────────────────────────────────────────────

create type role_enum        as enum ('SEEKER', 'ADMIN');
create type user_status_enum as enum ('ACTIVE', 'BANNED');
create type scan_status_enum as enum (
  'PENDING', 'SCANNING', 'COMPLETE_PASS', 'COMPLETE_FAIL',
  'FIX_PURCHASED', 'FIX_GENERATING', 'FIX_DELIVERED', 'ERROR'
);
create type pay_status_enum  as enum ('PENDING', 'SUCCESS', 'FAILED', 'ABANDONED');

-- ── users ──────────────────────────────────────────────────────────────

create table users (
  id                     uuid primary key default gen_random_uuid(),
  email                  text not null unique,
  password_hash          text not null,
  name                   text not null,
  role                   role_enum not null default 'SEEKER',
  status                 user_status_enum not null default 'ACTIVE',
  token_version          int not null default 0,
  email_verified         boolean not null default false,
  email_verify_token     text,
  email_verify_expiry    timestamptz,
  reset_token            text,
  reset_token_expiry     timestamptz,
  deleted_at             timestamptz,
  scans_today            int not null default 0,
  scans_day_reset        timestamptz not null default now(),
  -- WARNING: paystack_auth_code is a payment credential.
  -- NEVER include in any result sent to client. Stripped in middleware/auth.js.
  paystack_customer_code text,
  paystack_auth_code     text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index idx_users_email on users (email);

-- ── scans ──────────────────────────────────────────────────────────────

create table scans (
  id                    uuid primary key default gen_random_uuid(),
  status                scan_status_enum not null default 'PENDING',
  resume_path           text not null,              -- R2 object key
  resume_original_name  text not null,
  resume_mime_type      text not null,
  job_description_text  text,
  job_description_url   text,
  ats_score             int,
  passed                boolean,
  keyword_score         int,
  format_score          int,
  sections_score        int,
  content_score         int,
  full_ats_report       jsonb,                       -- NEVER sent to free client
  scan_completed_at     timestamptz,
  candidate_first_name  text,                        -- null until fix purchased — intentional
  fix_purchased         boolean not null default false,
  fix_tier              text,                        -- "FIX" | "BADGE"
  resume_ats_path       text,                        -- R2 object key
  resume_pdf_path       text,                        -- R2 object key
  fix_generated_at      timestamptz,
  cover_letter_text     text,                        -- Phase 1b
  verification_code     text unique,
  verification_url      text,
  verification_views    int not null default 0,
  resume_hash           text,
  verified_at           timestamptz,
  role_category         text,
  seniority_level       text,
  integrity_score       int,                         -- Phase 2
  user_id               uuid references users(id),
  anon_token            text unique,
  anon_expires_at       timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index idx_scans_user_id           on scans (user_id);
create index idx_scans_anon_token        on scans (anon_token);
create index idx_scans_verification_code on scans (verification_code);
create index idx_scans_status            on scans (status);

-- ── payments ───────────────────────────────────────────────────────────

create table payments (
  id                    uuid primary key default gen_random_uuid(),
  amount_cents          int not null,
  currency              text not null default 'USD',
  status                pay_status_enum not null default 'PENDING',
  paystack_ref          text not null unique,
  paystack_access_code  text,
  paystack_auth_code    text,
  user_id               uuid not null references users(id),
  scan_id               uuid references scans(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index idx_payments_user_id      on payments (user_id);
create index idx_payments_paystack_ref on payments (paystack_ref);

-- ── employer_leads ─────────────────────────────────────────────────────

create table employer_leads (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  company       text not null,
  email         text not null,
  role_category text,
  source        text not null default 'verification_page',
  created_at    timestamptz not null default now()
);

-- ── email_logs ─────────────────────────────────────────────────────────

create table email_logs (
  id        uuid primary key default gen_random_uuid(),
  "to"      text not null,
  subject   text not null,
  template  text not null,
  status    text not null,
  error     text,
  sent_at   timestamptz not null default now()
);

-- ── updated_at triggers (mirrors Prisma's @updatedAt) ─────────────────

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_users_updated_at
  before update on users
  for each row execute function set_updated_at();

create trigger trg_scans_updated_at
  before update on scans
  for each row execute function set_updated_at();

create trigger trg_payments_updated_at
  before update on payments
  for each row execute function set_updated_at();

-- ── RLS: disabled by design ────────────────────────────────────────────
-- All access goes through the Worker using the service_role key (server-side
-- only, never exposed to the frontend). RLS is intentionally left off because
-- there is no direct client-to-Supabase path in this architecture — every
-- request is authorized in application code (middleware/auth.js), exactly as
-- it was with Prisma + Express. If a direct browser-to-Supabase path is ever
-- added, RLS policies must be written before that ships.
