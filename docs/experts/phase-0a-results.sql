-- Passthrough Experts, Phase 0A: reading the Human rewrite demand test.
-- Run in the Supabase SQL editor (service role). Read-only: every statement is a SELECT. No admin screen and no CSV route exist in
-- Phase 0A; for a CSV use the editor's export, or psql:  \copy (<paste a query>) to 'out.csv' csv header
--
-- HOW TO READ THESE NUMBERS
--  * A "visitor" is a browser (a random id in its local storage), not a person. Someone on two devices counts twice and sees the
--    variant each device was dealt. Rates are per visitor.
--  * The price variant on every row was worked out by the SERVER from the visitor id; the browser cannot choose or fake it.
--  * waitlist_submitted events are written by the server only when a NEW waitlist row is created, so re-submits do not inflate it.
--  * To look at a window, add:  and created_at >= '2026-11-01'  to the events CTE (and to the waitlist CTE) of the query.
--  * Small samples: compare variants only once each has a few hundred viewers. These queries give counts, not significance.
--  * Compare against the bars the owner sets before the test starts (product spec section 23; see STATUS.md, open question 3).

-- 1. FUNNEL BY PRICE VARIANT: button views, clicks, click-through, waitlist joins, waitlist rate
with f as (
  select price_variant,
         count(distinct visitor_id) filter (where event = 'button_shown')       as viewers,
         count(distinct visitor_id) filter (where event = 'button_clicked')     as clickers,
         count(distinct visitor_id) filter (where event = 'waitlist_submitted') as joiners
  from human_demand_events
  group by price_variant
)
select price_variant, viewers, clickers, joiners,
       round(100.0 * clickers / nullif(viewers, 0), 2) as click_through_pct,       -- clickers / viewers
       round(100.0 * joiners  / nullif(viewers, 0), 2) as waitlist_rate_pct,       -- joiners  / viewers  (the number the gate cares about)
       round(100.0 * joiners  / nullif(clickers, 0), 2) as join_after_click_pct    -- joiners  / clickers
from f
order by case price_variant when 'low' then 1 when 'base' then 2 else 3 end;

-- 2. TIER MIX BY PRICE VARIANT: which tier people look at, and which they actually join the waitlist for
with picked as (
  select price_variant, tier, count(distinct visitor_id) as looked_at
  from human_demand_events where event = 'tier_selected' group by 1, 2
), joined as (
  select price_variant, tier, count(*) as waitlist_rows
  from human_demand_waitlist group by 1, 2
)
select coalesce(p.price_variant, j.price_variant) as price_variant, coalesce(p.tier, j.tier) as tier,
       coalesce(p.looked_at, 0) as visitors_who_picked_it, coalesce(j.waitlist_rows, 0) as waitlist_rows,
       round(100.0 * coalesce(j.waitlist_rows, 0) / nullif(sum(coalesce(j.waitlist_rows, 0)) over (partition by coalesce(p.price_variant, j.price_variant)), 0), 1) as share_of_variant_waitlist_pct
from picked p
full join joined j on j.price_variant = p.price_variant and j.tier = p.tier
order by 1, 2;

-- 3. COVER LETTER ATTACH RATE BY PRICE VARIANT: of the PEOPLE on the waitlist, how many ticked the cover letter (any tier)
with people as (
  select identity_key, price_variant, bool_or(cover_letter_interest) as wants_cover, bool_or(contact_consent) as ok_to_email
  from human_demand_waitlist
  group by identity_key, price_variant
)
select price_variant,
       count(*)                                         as people_on_waitlist,
       count(*) filter (where wants_cover)              as want_cover_letter,
       round(100.0 * count(*) filter (where wants_cover) / nullif(count(*), 0), 1) as cover_letter_attach_pct,
       count(*) filter (where ok_to_email)              as ok_to_email_at_launch
from people
group by price_variant
order by case price_variant when 'low' then 1 when 'base' then 2 else 3 end;

-- 4. COVER LETTER TOGGLES (people who ticked it in the modal, whether or not they went on to join)
select price_variant,
       count(distinct visitor_id) filter (where cover_letter is true)  as ticked_it,
       count(distinct visitor_id) filter (where cover_letter is false) as unticked_it
from human_demand_events
where event = 'cover_letter_toggled'
group by price_variant
order by 1;

-- 5. WHERE PEOPLE LEAVE: opened the modal but did not join, and the tier they had picked when they closed it
select price_variant, coalesce(tier, '(none chosen)') as tier_when_dismissed, count(distinct visitor_id) as visitors
from human_demand_events
where event = 'modal_dismissed'
group by 1, 2
order by 1, 2;

-- 6. SANITY: a visitor id must never appear under two variants (expected: zero rows). Any row here means the assignment changed
--    mid-test (for example the salt in src/lib/humanDemand.js was edited) and the variant comparison is not clean.
select visitor_id, array_agg(distinct price_variant) as variants
from human_demand_events
group by visitor_id
having count(distinct price_variant) > 1;

-- 7. SANITY: events per day (a quick look for a stuck button or a bot)
select date_trunc('day', created_at)::date as day, event, count(*) as events
from human_demand_events
group by 1, 2
order by 1 desc, 2;
