# A11 pass 1: frontend and expert site build

Base `e655154` (31 Oct 2026; first read on `7ac8e06`, re-cloned twice as A6 and A10 landed; neither touched this section). Scope: `frontend/src/experts/*`, `public-experts/*`, `vite.experts.config.js`, `public/_headers`, `pages/human`, `pages/expert`, the order tracker, `lib/humanApi.js`, the `/v/:code` Function as deployed on the expert host.

Method: both bundles built and searched (the expert bundle holds no storage key, API address, Paystack or Turnstile code; the main bundle holds no expert entry; the sitemap lists no human or expert path); each suspected bug written as a test that states the correct behaviour and run against the old code first (it failed for the stated reason), then against the fix.

## Findings and what was done

| # | Finding | Fix |
|---|---|---|
| B1 | Coming back from Paystack, the orders page treated any non-error answer as "Payment received" (a 202 `pending` included) and every error as "still confirming, this page updates on its own", which nothing did; declined, needs-support and rate-limited answers were lost. | `lib/humanPaymentCheck.js` reads each answer of `/payments/verify`; pending is polled (bounded), a failure and a support case state the server's words, a blip is retried twice, "Check again" is offered. |
| B2 | Cancel (a refund) and Accept (ends the one revision) fired on one click. | Each asks once, in words that say what it does. |
| B3 | The expert site never noticed a session the server had ended (idle, sign out everywhere, password change): it stayed on the screen with the signed-in nav and an error. | The API client tells the session owner on `401` with code `AUTH`; the app returns to sign-in and says why; coming back to the tab after a minute asks the server again. Wrong password and wrong code carry other codes and are untouched. |
| B4 | The refund amount was read with `parseFloat`: `10,50` sent $10.00, `1,000` sent $1, `1e3` sent $1,000. | `experts/money.js`: digits and one dot only, whole cents from the digits; the form shows what it will refund. |
| B5 | The orders page printed "expected by <original deadline>" in every state, including cancelled, refunded and accepted, and the original deadline during a revision. | Removed; the tracker is the one place a deadline is shown. |
| B6 | The tracker showed an unpaid order as "Order received" and a revision as "Ready for your review". | Unpaid shows "Waiting for payment"; a revision says "Your revision is being made". |
| B7 | `/human/*` and `/expert/*` were not private paths: homepage tab title, no noindex meta, a canonical link; no noindex or no-store header. | `pageTitles.js` (private, own titles) and `public/_headers` (noindex, no-store, no-referrer). |
| B8 | `public-experts/_headers`: `/assets/*` added `immutable` to the catch-all's `no-store`; Pages joins same-named headers, so the built files were never cached. | `! Cache-Control` first; a test reads the file the way Pages does. |
| B9 | Job board and audit log kept answers of an earlier filter when answers arrived out of order, never cleared an old error, and the audit filter sent a request per keystroke. | Newest-request-wins guards, errors cleared on a new load, 350 ms pause before the filter is applied. |
| B10 | Two-factor enrolment asked the server for a setup key on every mount; the server replaces the unconfirmed key each time, so leaving and returning (or a development double render) invalidated the key already in the phone. | One key per enrolment, kept with the session; concurrent asks share one request. |
| B11 | A failed orders load also said "You have no human rewrite orders." | Shown only when the load did not fail. |
| B12 | `dev:experts` proxy sent the right Host but not the Origin the CSRF check requires: every sign-in refused. (Reasoned from the code; not run against a live API.) | The proxy states both; the page answers every non-file route in dev. |
| B13 | The expert Pages project is built from the same folder and so also deploys the main site's `/v/:code` Function. | The Function is a pass-through on an `experts.` host; the checklist says not to set `API_URL` there. |
| B14 | The expert fallback rewrote to `/experts.html`; Pages documents only `/* /index.html 200`. | The build writes `index.html`; `_redirects` uses the documented form. (Not testable without Pages.) |

Feature gaps built: G1 pay an unpaid order from the orders page (`POST /api/human/orders/:id/pay` hands back the still-open Paystack checkout under its stored access code; no new transaction or reference; refused with a plain message once paid, closed or abandoned); G2 supporting materials listed, removed and added from the orders page while the server allows it; G3 a dashboard link to the orders (flag-gated, shown only to an account that has orders), `?order=` opens an order, and a refused second order links to the existing one; G4 the orders page refreshes itself every minute while any order can change (not while the tab is hidden); G5 expert site tab titles and a screen-reader route announcement.

## Not tested here

Cloudflare Pages behaviour itself (B8 header joining, B14 rewrite, B13 Function packaging) is reasoned from Pages' documented rules; the tests read the files the way Pages does. B12 needs a running API. `npm run build` and `npm run build:experts` both succeed.
