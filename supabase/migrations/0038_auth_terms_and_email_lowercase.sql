-- Auth/Scan audit round.
--
-- 1. Legacy mixed-case emails. 0017 added a unique index on lower(email) and
--    the application now lowercases every email it reads or writes — but no
--    migration ever lowercased the rows that already existed (employer_leads
--    got exactly that backfill in 0021/0032; users never did). Login,
--    forgot-password and the duplicate-email checks all look up
--    `.eq('email', <lowercased input>)`, which is a case-SENSITIVE match, so
--    any account created before that normalization with a capital letter in
--    its address could neither sign in nor receive a password-reset email —
--    and could not re-register either (the lower() index blocks it). Safe to
--    run: idx_users_email_lower_unique guarantees the UPDATE cannot collide.
--
--    To see whether anyone was affected before applying:
--      select id, email from users where email <> lower(email);
--
-- 2. The same guarantee as a CHECK, so a future code path or manual edit can't
--    reintroduce a mixed-case row.
--
-- 3. Terms/Privacy acceptance recorded at sign-up (users.terms_accepted_at /
--    terms_version). Existing accounts stay NULL — they signed up before the
--    checkbox existed — and are not blocked by it.

update users set email = lower(email) where email <> lower(email);
update users set pending_email = lower(pending_email)
  where pending_email is not null and pending_email <> lower(pending_email);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'users_email_lowercase_chk') then
    alter table users add constraint users_email_lowercase_chk check (email = lower(email));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'users_pending_email_lowercase_chk') then
    alter table users add constraint users_pending_email_lowercase_chk
      check (pending_email is null or pending_email = lower(pending_email));
  end if;
end $$;

alter table users add column if not exists terms_accepted_at timestamptz;
alter table users add column if not exists terms_version      text;
