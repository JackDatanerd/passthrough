-- Partners / referral program, round 11.
--
-- B3 (erasure): adminAnonymizePartner could only clean the partner's CURRENT address out of email_logs / alert_logs.
-- After an admin changed the address, the notices sent to (and alerts quoting) the OLD one stayed behind. The
-- addresses a partner used to have are now remembered so the erasure can reach them; the list is emptied by the
-- erasure itself. Addresses changed BEFORE this migration cannot be recovered and age out with the retention sweep.
alter table partners
  add column if not exists previous_emails text[] not null default '{}';
