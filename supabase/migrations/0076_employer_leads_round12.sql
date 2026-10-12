-- Employer leads, round 12 (independent audit, Section 5; migration 0076). Idempotent — safe to re-run.
--
-- 1. employer_leads.mailbox_key — the INBOX an address delivers to, as lib/mailbox.js canonicalMailbox() computes
--    it: lower-cased, a `+tag` dropped from the local part, and for Gmail / Googlemail the dots dropped and the
--    domain unified. The do-not-contact list and the per-recipient mail caps have treated these spellings as one
--    inbox since round 11, but leads are stored under the address AS TYPED, so nothing could find "every lead for
--    this inbox": removing dana@gmail.com left a lead stored as dana+jobs@gmail.com (its name, company and address)
--    behind, next to a promise on the remove page and in the Privacy notice that the request is deleted.
--    The column is maintained by a trigger, so every write path (public form, admin add / edit / import, the rejoin
--    page, set_lead_field) keeps it right without each one remembering to; the application only ever READS it.
--    lead_mailbox_key() is a line-for-line port of canonicalMailbox() — tests/fixtures/mailbox-keys.json holds the
--    pairs both are checked against.
-- 2. source = 'import' — leads brought in through the CSV import used to be stored as source 'manual', so the admin
--    list could not tell them from leads typed in one at a time. Existing imports are relabelled (confirmed_via
--    already says which they are).

create or replace function lead_mailbox_key(p_email text)
returns text
language plpgsql
immutable
as $$
declare
  e       text := lower(btrim(coalesce(p_email, '')));
  at_pos  int;
  loc     text;
  dom     text;
  plus    int;
begin
  -- Position (1-based) of the LAST '@'. Anything without one, or that starts with it, is returned unchanged.
  at_pos := length(e) - position('@' in reverse(e)) + 1;
  if position('@' in e) = 0 or at_pos < 2 then
    return e;
  end if;
  loc := left(e, at_pos - 1);
  dom := substr(e, at_pos + 1);
  plus := position('+' in loc);
  if plus > 1 then
    loc := left(loc, plus - 1);
  end if;
  if dom in ('gmail.com', 'googlemail.com') then
    loc := replace(loc, '.', '');
    dom := 'gmail.com';
  end if;
  if loc = '' then
    return e;
  end if;
  return loc || '@' || dom;
end;
$$;

alter table employer_leads add column if not exists mailbox_key text;

create or replace function employer_leads_set_mailbox_key()
returns trigger
language plpgsql
as $$
begin
  new.mailbox_key := lead_mailbox_key(new.email);
  return new;
end;
$$;

drop trigger if exists trg_employer_leads_mailbox_key on employer_leads;
create trigger trg_employer_leads_mailbox_key
  before insert or update of email on employer_leads
  for each row execute function employer_leads_set_mailbox_key();

-- Existing rows. (Not touching updated_at: it is mergeIntoExistingLead's concurrency token.)
update employer_leads set mailbox_key = lead_mailbox_key(email)
 where mailbox_key is distinct from lead_mailbox_key(email);

create index if not exists idx_employer_leads_mailbox_key on employer_leads (mailbox_key);

update employer_leads set source = 'import'
 where source = 'manual' and confirmed_via = 'import';

-- Always the LAST statement of a migration: records how far this database has been migrated.
insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 76, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now();
