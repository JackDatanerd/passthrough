// Run with: node supabase/seed.js
// Reads credentials from environment — set SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY before running (or copy .dev.vars to .env
// temporarily and uncomment the dotenv line below).
//
// This replaces backend/prisma/seed.js. Same demo data as the v8 spec —
// admin + demo user + three demo scans (fail/pass/delivered).

// require('dotenv').config({ path: '.dev.vars' })  // uncomment if needed locally

const { createClient } = require('@supabase/supabase-js')
const bcrypt = require('bcryptjs')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000'

async function upsertUser({ email, name, role = 'SEEKER', emailVerified = true, password }) {
  const passwordHash = await bcrypt.hash(password, 10)
  const { data: existing } = await supabase.from('users').select('id').eq('email', email).maybeSingle()
  if (existing) return existing
  const { data, error } = await supabase.from('users').insert({
    email, name, role, email_verified: emailVerified, password_hash: passwordHash
  }).select('id').single()
  if (error) throw error
  return data
}

async function upsertScan(id, data) {
  const { data: existing } = await supabase.from('scans').select('id').eq('id', id).maybeSingle()
  if (existing) { console.log(`  scan ${id} already exists, skipping`); return }
  const { error } = await supabase.from('scans').insert({ id, ...data })
  if (error) throw error
}

async function main() {
  console.log('Seeding...')

  const admin = await upsertUser({
    email: 'admin@passthrough.dev',
    name:  'Passthrough Admin',
    role:  'ADMIN',
    emailVerified: true,
    password: 'Admin@Passthrough2024!'
  })
  console.log('✓ admin user')

  const seeker = await upsertUser({
    email: 'demo@passthrough.dev',
    name:  'Demo User',
    emailVerified: true,
    password: 'Demo@Passthrough2024!'
  })
  console.log('✓ demo user')

  const now = new Date().toISOString()

  await upsertScan('demo-fail-cf', {
    status:               'COMPLETE_FAIL',
    user_id:              seeker.id,
    resume_path:          'resumes/demo-fail',
    resume_original_name: 'resume.pdf',
    resume_mime_type:     'application/pdf',
    job_description_text: 'Demo JD',
    ats_score:            42,
    passed:               false,
    keyword_score:        35,
    format_score:         80,
    sections_score:       55,
    content_score:        25,
    scan_completed_at:    now
  })
  console.log('✓ demo-fail scan')

  await upsertScan('demo-pass-cf', {
    status:               'COMPLETE_PASS',
    user_id:              seeker.id,
    resume_path:          'resumes/demo-pass',
    resume_original_name: 'resume-v2.pdf',
    resume_mime_type:     'application/pdf',
    job_description_text: 'Demo JD',
    ats_score:            77,
    passed:               true,
    keyword_score:        72,
    format_score:         85,
    sections_score:       80,
    content_score:        70,
    scan_completed_at:    now
  })
  console.log('✓ demo-pass scan')

  await upsertScan('demo-delivered-cf', {
    status:               'FIX_DELIVERED',
    user_id:              seeker.id,
    resume_path:          'resumes/demo-delivered',
    resume_original_name: 'resume-v3.pdf',
    resume_mime_type:     'application/pdf',
    job_description_text: 'Demo JD',
    ats_score:            88,
    passed:               true,
    keyword_score:        90,
    format_score:         92,
    sections_score:       85,
    content_score:        84,
    scan_completed_at:    now,
    fix_purchased:         true,
    fix_tier:              'FIX',
    verification_code:     'DEMO01',
    verification_url:      `${FRONTEND_URL}/v/DEMO01`,
    candidate_first_name:  'Demo',
    verified_at:            now,
    role_category:          'software_engineering',
    seniority_level:        'mid'
  })
  console.log('✓ demo-delivered scan')

  console.log('\nSeed complete.')
  console.log('Admin: admin@passthrough.dev / Admin@Passthrough2024!')
  console.log('Demo:  demo@passthrough.dev  / Demo@Passthrough2024!')
  console.log('!! Change both passwords before going live !!')
}

main().catch(e => { console.error(e); process.exit(1) })
