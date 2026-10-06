// DEVELOPMENT / STAGING ONLY — never run this against the production project.
//
//   SEED_ENV=development node supabase/seed.js
//
// Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment.
// Creates an ADMIN user, a demo user and three demo scans (fail / pass /
// delivered). The delivered one publishes a fake "Passthrough Verified" page
// at /v/DEMO01 — on a real domain that is a forged credential, which is the
// second reason this must never touch production.
//
// Passwords are NOT in this file (the repository is public): set
// SEED_ADMIN_PASSWORD / SEED_DEMO_PASSWORD, or a random one is generated and
// printed once. Existing users are left exactly as they are.

const { createClient } = require('@supabase/supabase-js')
const bcrypt = require('bcryptjs')
const crypto = require('crypto')

if (process.env.SEED_ENV !== 'development' || process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed: this script creates an admin account and a fake verified page.')
  console.error('It is for development/staging only. Run it as:  SEED_ENV=development node supabase/seed.js')
  process.exit(1)
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.')
  process.exit(1)
}

// A password you supply, or a fresh random one (returned so main() can print it once).
function passwordFor(envName) {
  const given = process.env[envName]
  if (given) {
    if (given.length < 12) { console.error(`${envName} must be at least 12 characters.`); process.exit(1) }
    return { value: given, generated: false }
  }
  return { value: crypto.randomBytes(18).toString('base64url'), generated: true }
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000'

async function upsertUser({ email, name, role = 'SEEKER', emailVerified = true, password }) {
  const { data: existing } = await supabase.from('users').select('id').eq('email', email).maybeSingle()
  if (existing) return existing
  const passwordHash = await bcrypt.hash(password, 10)
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

  const adminPw = passwordFor('SEED_ADMIN_PASSWORD')
  const demoPw  = passwordFor('SEED_DEMO_PASSWORD')

  const admin = await upsertUser({
    email: 'admin@passthrough.dev',
    name:  'Passthrough Admin',
    role:  'ADMIN',
    emailVerified: true,
    password: adminPw.value
  })
  console.log('✓ admin user')

  const seeker = await upsertUser({
    email: 'demo@passthrough.dev',
    name:  'Demo User',
    emailVerified: true,
    password: demoPw.value
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
  // Existing accounts keep their own passwords; only a freshly generated one is shown (once).
  if (adminPw.generated) console.log(`Admin: admin@passthrough.dev / ${adminPw.value}   (generated — shown once)`)
  if (demoPw.generated)  console.log(`Demo:  demo@passthrough.dev  / ${demoPw.value}   (generated — shown once)`)
}

main().catch(e => { console.error(e); process.exit(1) })
