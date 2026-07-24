-- Supports the user-facing "Try Again" retry mechanism on a fix that fell
-- short of the badge threshold, and the free-credit fallback if retries are
-- exhausted without reaching it.
alter table scans add column fix_retry_count int not null default 0;
alter table users add column free_fix_credits int not null default 0;

-- Atomic increment — avoids the same read-modify-write race that
-- increment_verification_views (0002_helpers.sql) was written to avoid.
create or replace function increment_free_fix_credits(p_user_id uuid)
returns void
language sql
security definer
as $$
  update users
  set free_fix_credits = free_fix_credits + 1
  where id = p_user_id;
$$;
