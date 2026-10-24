#!/usr/bin/env node
// One-off (Western placeholders round 5): seal the partner tax IDs that were written in plain text before tax IDs were encrypted.
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... TAX_ID_ENCRYPTION_KEY=... node scripts/encrypt-tax-ids.cjs            # dry run: counts what would be sealed
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... TAX_ID_ENCRYPTION_KEY=... node scripts/encrypt-tax-ids.cjs --apply    # seals them
//
// Safe to re-run: rows that are already sealed are skipped. Use the SAME TAX_ID_ENCRYPTION_KEY the Worker has (wrangler secret).
const { createClient } = require('@supabase/supabase-js')
const { sealLegacyTaxIds } = require('../src/lib/fieldCrypto')

;(async () => {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TAX_ID_ENCRYPTION_KEY } = process.env
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !TAX_ID_ENCRYPTION_KEY) {
    console.error('Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and TAX_ID_ENCRYPTION_KEY.'); process.exit(1)
  }
  const apply = process.argv.includes('--apply')
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  const r = await sealLegacyTaxIds(supabase, { TAX_ID_ENCRYPTION_KEY }, { apply })
  console.log(apply ? `Sealed ${r.sealed} tax ID(s); ${r.skipped} were already sealed.` : `Dry run: ${r.sealed} tax ID(s) would be sealed; ${r.skipped} are already sealed. Re-run with --apply.`)
})().catch(e => { console.error(e); process.exit(1) })
