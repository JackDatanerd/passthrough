# Phase 2A deployment checklist (do in this order; nothing here is done for you)

The realm stays **off** until step 9. Steps 1 to 8 change nothing a customer or the pilot can see.

**0. Before you start.** Make the GitHub repo private again. Take a Supabase backup (Dashboard > Database > Backups) or note the restore point.

**1. Apply the migration first, in the Supabase SQL editor.** Paste `supabase/migrations/0127_experts_phase2a_realm.sql` and run it once. It only adds. Check:
`select version, name from applied_migrations where version in (124, 126, 127);` and `select value from system_state where key = 'schema_version';` (version 127).
It also copies the Phase 1 pilot jobs' pauses and next actions into the new tables (rows marked `phase1_backfill`); nothing existing is changed. Order matters: the code in step 2 expects 127, and a database ahead of the code is fine, so migrate before you deploy.
(Seen, not fixed: `0125_partners_section4_round44.sql` records itself as version 124, so the ledger has no row for 125. Not caused by this work; see CHANGES section 8.)

**2. Deploy the Worker with the flag off.** Apply the patch, push. Confirm `https://api.usepassthrough.com/health` is healthy with schema 127 and the main site, sign-in, a scan and the Phase 1 pilot behave as before. With `EXPERT_REALM_ENABLED` unset, `/api/expert-realm/*` and `/api/expert-admin/*` answer 404.

**3. Secrets and variables (Worker, Cloudflare dashboard or `wrangler secret put`).**
- `EXPERT_REALM_SECRET`: a new random secret, 32+ characters, **different from `JWT_SECRET` and `EXPERT_JWT_SECRET`** (for example `openssl rand -base64 48`). The realm refuses to run otherwise.
- `EXPERT_SITE_URL` = `https://experts.usepassthrough.com` (exactly, no trailing slash).
- `EXPERT_EMAIL_FROM` = `Passthrough Experts <experts@experts.usepassthrough.com>`.
- Already present from Phase 1 and needed: the field-encryption key (seals the two-factor secrets), `RESEND_API_KEY`, `SUPABASE_*`.
- Do **not** add the expert site to `CORS_EXTRA_ORIGINS`. The expert page calls the API on its own host, so it needs no CORS, and adding it would let that origin call the main API cross-site.

**4. The expert site (Cloudflare Pages, a new project).** Connect the same repo. Root directory `frontend`, build command `npm run build:experts`, output directory `dist-experts`, no build variables needed (it never reads `VITE_API_URL`). Add the custom domain `experts.usepassthrough.com`.

**5. DNS and the API route.**
- DNS: `experts` CNAME to the Pages project (proxied), as Pages instructs when you add the custom domain.
- Worker route: add the route `experts.usepassthrough.com/api/*` to the **API Worker** (zone `usepassthrough.com`; in `wrangler.toml`: `routes = [{ pattern = "experts.usepassthrough.com/api/*", zone_name = "usepassthrough.com" }]`, or Workers > the Worker > Settings > Domains & Routes). This is what makes the cookie first-party to the expert site: the browser calls `/api/...` on `experts.usepassthrough.com`, the route sends it to the Worker, and the Worker accepts the realm only on that host.
- **Verify** (this is the part I could not test): `curl -i https://experts.usepassthrough.com/api/expert-realm/me` should say 404 while the flag is off, and the same path on `api.usepassthrough.com` must also say 404. If the Pages site answers instead of the Worker, the route is not taking precedence; fix the route before going further.

**6. Email identity for the expert domain.** In Resend, add the domain `experts.usepassthrough.com` and publish the DNS records Resend shows you: the SPF record, the DKIM record(s), and a DMARC record at `_dmarc.experts.usepassthrough.com` (start with `v=DMARC1; p=none; rua=mailto:<your address>` for two weeks, read the reports, then move to `p=quarantine`). Wait until Resend shows the domain verified. Send yourself a reset link (step 8) and check the message lands in the inbox, not spam, with SPF, DKIM and DMARC all "pass" in the message headers.

**7. Staff accounts.** Make yours by hand: `docs/experts/phase2a/staff-accounts.md`. Pilot experts keep their Phase 1 email and password; on the new site they enter the same authenticator code and are shown ten recovery codes on first sign-in (they must save them).

**8. Try it with the flag still off, then on for you only.** Set `EXPERT_REALM_ENABLED=true`. It is a switch for the whole realm (there is no per-person switch here), so do steps 8 to 10 yourself before telling anyone.

**9. Before you let anyone else in (the gate).**
- Sign in on a real phone: password, authenticator code, recovery codes shown once; sign out; sign back in with a recovery code; "Sign out everywhere".
- In browser dev tools > Application > Cookies, `experts.usepassthrough.com` shows `__Host-pt_xr` with HttpOnly, Secure, SameSite=Strict, Path `/`, no Domain; Local Storage and Session Storage hold nothing.
- Cross-realm against the deployed app: with your expert-site session, call a main-app route (for example `GET https://api.usepassthrough.com/api/auth/me` with the cookie value as `Authorization: Bearer ...`) and a main-admin route; both must be 401 or 403. Then, signed in to the main app as a customer, copy that token into the expert site's cookie (dev tools) and reload: you must be sent to sign in.
- A real small refund in **test mode**: pay a test human order (Paystack test keys), open its job in the console as expert_admin, Refund, confirm your password, enter a reason, send it; check the refund appears at Paystack, the order updates when it completes, and `expert_audit_log` shows `money.refund_requested` then `money.refund_queued`. Repeat with the same request key from the browser's network replay: no second refund.
- Support account: sign in as `expert_support` and confirm there is no refund button, no Experts link, no Audit log link.

**Rollback.**
1. Set `EXPERT_REALM_ENABLED` to anything but `true` (or delete it): the whole realm is a 404 again, immediately. Customers and the Phase 1 pilot are unaffected.
2. Phase 1 (`EXPERTS_ENABLED`, `/api/expert`) was not changed and keeps working throughout, so pilot experts can fall back to it.
3. If you must undo the data: `docs/experts/phase2a/rollback-0127.sql` (level 1 removes only the copied pilot data; level 2 drops everything 0127 added).
4. To undo the code: `git revert` the Phase 2A commit and push. Revert only after level 2 if you revert the schema version.
