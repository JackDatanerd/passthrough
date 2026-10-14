#!/usr/bin/env node
// One-off (Verify round 12): re-derive scans.candidate_first_name with the corrected name parser.
//
// Why: lib/text.js firstNameOf used to print the wrong word for "Dr. Doe, John" ("Doe"), "van der Berg, Jan" ("van")
// and "Mba ...". The wrong token was STORED at write time, so fixing the parser cannot repair pages that already exist.
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/backfill-candidate-names.cjs            # dry run: prints what would change
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/backfill-candidate-names.cjs --apply    # writes
//
// Safe to re-run. Only rows whose derived name DIFFERS from the stored one are touched, and a row whose resume has no
// usable name is left exactly as it is (the same "keep what is there" rule the write path uses).
const { createClient } = require('@supabase/supabase-js')
const { publicFirstName } = require('../src/lib/text')

const APPLY = process.argv.includes('--apply')
const PAGE = 500

async function main() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'); process.exit(1) }
  const db = createClient(url, key, { auth: { persistSession: false } })

  let from = 0, scanned = 0, changed = 0, failed = 0
  for (;;) {
    const { data, error } = await db.from('scans')
      .select('id, candidate_first_name, user_edited_resume_data, rewritten_resume_data, original_resume_data')
      .not('candidate_first_name', 'is', null)
      .order('id', { ascending: true }).range(from, from + PAGE - 1)
    if (error) { console.error('read failed:', error.message); process.exit(1) }
    if (!data || !data.length) break
    for (const row of data) {
      scanned++
      // The same precedence the write path uses: what the owner vouched for, then the rewrite, then the original.
      const source = row.user_edited_resume_data || row.rewritten_resume_data || row.original_resume_data
      const next = publicFirstName(source && source.name)
      if (!next || next === row.candidate_first_name) continue
      changed++
      console.log(`${row.id}: ${JSON.stringify(row.candidate_first_name)} -> ${JSON.stringify(next)}`)
      if (APPLY) {
        const { error: upErr } = await db.from('scans').update({ candidate_first_name: next }).eq('id', row.id)
        if (upErr) { failed++; console.error(`  could not update ${row.id}: ${upErr.message}`) }
      }
    }
    if (data.length < PAGE) break
    from += PAGE
  }
  console.log(`${APPLY ? 'Applied' : 'Dry run'}: scanned ${scanned}, ${changed} ${APPLY ? 'updated' : 'would change'}${failed ? `, ${failed} failed` : ''}.`)
  if (failed) process.exit(2)
}
main().catch(err => { console.error(err); process.exit(1) })
