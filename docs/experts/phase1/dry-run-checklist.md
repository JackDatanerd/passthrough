# Phase 1 dry run: ten synthetic jobs, checkout to acceptance

Do this on a **staging deployment with Paystack TEST keys and a staging database**, never on production. Nothing in this repo has been run against a live database, a real browser, real payments, a deployment or real email delivery; this checklist is how you find out. Stop at the first step that does not behave as written and send me the step number.

## 0. Set up (once)

1. Back up the staging database. Run migration `0124_experts_phase1_pilot.sql`, then confirm: `select value from system_state where key = 'schema_version'` shows 124, and `select value from system_state where key = 'human_pilot'` shows the prices (polish off, pilot cap 15).
2. Worker variables: `EXPERTS_ENABLED=true`; `EXPERTS_ALLOWED_EMAILS=<your two test customer emails>`; `EXPERT_JWT_SECRET=<32+ random characters, NOT equal to JWT_SECRET>`; confirm `TAX_ID_ENCRYPTION_KEY` is set. Turn `HUMAN_DEMAND_ENABLED` **off** (otherwise the offer card shows the waitlist button and the real link).
3. Build the frontend with `VITE_EXPERTS_ENABLED=true`. Deploy.
4. Make **two** test experts: Admin > Human orders > Experts > Create expert (use two mailboxes you control). Copy each temporary password (shown once). Switch each **on** and click **Agreement signed**. Sign in at `/expert` as each: password, scan the key into an authenticator app, enter the code. Both rows must now show `2FA ✓` and `agreement ✓`.
5. Make **two** test customer accounts with a scanned resume each, and open each resume in the editor once (so the structured copy exists).
6. Confirm the old behaviour is intact: with the flag **off** (set `EXPERTS_ENABLED=false`, redeploy or use a second environment), `GET /api/human/config`, `/api/expert/jobs` and `/api/admin/human/orders` all return the ordinary 404 and the AI Fix checkout still works end to end. Then turn it back on.

## 1. The ten jobs

For each job: customer places the order at the offer card link, pays with a Paystack test card, and the order must appear in Admin > Human orders as **offered** (payment SUCCESS) and the customer must get the "We have your human rewrite order" email. Then:

| # | Tier | What to do | You must see |
|---|---|---|---|
| 1 | 48-hour, no cover letter | Assign to expert A. A edits the summary and two bullets, **Save and send for review**. Operator: Review and deliver. Customer: download Word and PDF, **Accept**. | Job goes claimed, in progress, in review, delivered, accepted. ATS score before and after shown. Delivered email arrives. One pay row for the expert (`select * from expert_earnings`). Active minutes recorded. Contact details are in the files and **no `[[` markers**. |
| 2 | 7-day **with cover letter** | As job 1, expert also edits the cover letter. | Cover letter file is offered for download. Price was 8900 + 2900; pay 5000 + 1800 on the job row. |
| 3 | 24-hour | Expert A asks one question. Customer answers. | Job shows "The expert has a question" and the customer got the question email. The promised deadline moves later by the time waited. |
| 4 | 48-hour | Expert asks a question the customer does **not** answer. Set `update job_questions set answer_deadline_at = now() - interval '1 minute'` then wait for the next hourly tick. | Question expires, job returns to in progress, deadline pushed back. |
| 5 | 48-hour | Deliver, then customer asks for the **revision** with a reason. Expert changes it, submits, operator delivers again. Customer asks for a second revision. | Revision goes back to the **same** expert; redelivery is version 2; the second request is refused ("The one revision included ... has been used"). |
| 6 | 48-hour | Operator clicks **Send back to the expert** with a note (the note is required). Expert changes it and resubmits. | Job returns to in progress with the expert; delivery works afterwards. |
| 7 | 48-hour | Expert adds a figure the customer never gave (for example "cut churn 55%"). Operator tries to deliver. | Delivery is **blocked** and lists `55%`. Tick it confirmed (or give a written reason) and delivery succeeds; the customer sees the figure under "please check these figures". |
| 8 | 7-day | Customer clicks **Cancel for a full refund** while the job is still **offered**. | Job cancelled before assignment; Paystack refund starts; payment becomes REFUNDED when Paystack confirms; no earnings row. A job already taken by an expert shows no cancel button. |
| 9 | 48-hour | Deliver and accept (as job 1), then operator clicks **Refund**. | After Paystack confirms: payment REFUNDED, job refunded, the expert's pay row is reversed by one negative row (sum 0), the customer gets the refund email. Repeat the webhook (Paystack dashboard resend): nothing changes. |
| 10 | 48-hour | With a welcome / partner / discount code in the customer's session or cart and a promo price window active, place a human order. | Price is exactly the settings price. The page says the code "was not used and is still saved". No code usage, commission or attribution row appears (`select count(*)` on the referral and commission tables before and after). |

## 2. Cross-checks (once)

- **Auto-accept:** on a delivered job set `update human_jobs set auto_accept_at = now() - interval '1 minute' where id = '...'`; after the next hourly tick it is accepted, with exactly one pay row; a second tick changes nothing.
- **Unpaid expiry:** start an order and never pay; set its `created_at` back 25 hours; after the tick it is cancelled and its documents are gone.
- **Expert isolation:** as expert B, open expert A's job URL (`/api/expert/jobs/<id>`): 403, and `select * from expert_audit_log order by id desc limit 5` shows `denied_job_access`. As expert A, try to change a locked line (email, employer) or type an email into the text: the save is refused with a message.
- **Realm isolation:** copy an expert token (browser session storage `pt_expert_token`) and call a normal app route and `/api/admin/...` with it: 401. Use a normal app token on `/api/expert/jobs`: 401.
- **Payout:** Experts tab > payment reference > **Record payout** for an expert with available earnings (after the 3-day hold; to test sooner, update `release_at` to the past). Click it twice: one payout row, the same amount shown "(already recorded)".
- **Reconcile a paid-but-stuck payment:** in Admin payments, recheck a SUCCESS human payment: nothing changes and no AI-fix mail is sent.
- **Retention:** set an accepted job's `updated_at` back 91 days; after the tick its files and documents are gone and the job row and its earnings remain.
- **Pilot cap:** set `pilot_cap_orders` to the number of paid jobs; the next order is refused with "at capacity" and the offer link disappears.

## 3. Then, before the first real order

See the end of `CHANGES-experts-phase-1.txt` ("What must be true before the first paid order").
