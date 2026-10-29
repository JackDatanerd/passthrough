# Making staff accounts by hand (expert admin, support, grader)

There is no sign-up for staff and no screen that creates them. This is the whole procedure.

1. On your machine, in the repo folder:
   `node scripts/expert-staff-account.cjs --email you@example.com --first Jack --initial K --role expert_admin`
   (`--role expert_support` or `grader` for the others; `--roles expert_admin,expert` for more than one.)
2. It prints one SQL statement and a first password. The password appears **once**; only its hash is in the SQL.
3. Run the SQL in the Supabase SQL editor. If the email already exists, nothing changes.
4. Open the expert site, sign in with that email and password, scan the setup key into an authenticator app, enter the code, and **save the ten recovery codes** that appear (they are shown once).
5. Settings > Password: change the printed password. That signs every session out; sign in again.
6. To remove access later: set `enabled = false` on the account (its sessions stop on their next request), or use "Sign out everywhere" from Settings while signed in as that person.

Rules: staff accounts are never created from the main app's users or admin screens; an account's roles are the only thing that decides what it can do (see the permission matrix in `src/lib/expertRealm/permissions.js`); a lost phone is fixed by a recovery code, and a lost phone with no codes by an existing admin resetting the second factor in SQL (`update expert_accounts set totp_secret_enc = null, totp_enabled_at = null, totp_last_step = null where email = '...'`, then `delete from expert_recovery_codes` for that account), which sends them back through setup at next sign-in.
