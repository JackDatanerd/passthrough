-- anon_token is a bearer capability (view/edit/claim an anonymous scan). Every
-- other bearer token (reset, email-verify, pending-email) is stored as a sha256
-- hash; this one was raw. Hash existing rows in place — the app now compares
-- sha256(presented token) against this column, so links already emailed and
-- tokens already held in browsers keep working.
-- Raw tokens are UUIDs (36 chars, dashed); a 64-hex value is already hashed, so
-- the WHERE clause makes this safe to re-run.
update scans
   set anon_token = encode(sha256(convert_to(anon_token, 'utf8')), 'hex')
 where anon_token is not null
   and anon_token !~ '^[0-9a-f]{64}$';
