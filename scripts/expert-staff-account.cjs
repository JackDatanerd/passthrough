#!/usr/bin/env node
// Experts Phase 2A: make an expert-realm STAFF account (expert_admin, expert_support or grader) by hand. It never touches a database: it prints one
// SQL statement for you to run in the Supabase SQL editor, and prints the first password ONCE on screen. Only a bcrypt hash goes into the SQL.
//
//   node scripts/expert-staff-account.cjs --email you@example.com --first Jack --initial K --role expert_admin
//   (roles: expert_admin | expert_support | grader; add --roles expert_admin,expert to hold more than one)
//
// The account is created ENABLED and ACTIVE with no second factor yet: the first sign-in on the expert site walks through setting up the authenticator
// app and shows the ten recovery codes once. Change the printed password in Settings after that. See docs/experts/phase2a/staff-accounts.md.
const bcrypt = require('bcryptjs')
const crypto = require('crypto')

const STAFF = ['expert_admin', 'expert_support', 'grader']
const ALL = ['expert', ...STAFF]
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const newPassword = () => Array.from(crypto.randomBytes(24), b => ALPHABET[b % ALPHABET.length]).join('').replace(/(.{6})(?=.)/g, '$1-')
const q = v => `'${String(v).replace(/'/g, "''")}'`

function parse(argv) {
  const o = {}; for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
  return o
}

function build(o, { password = newPassword(), rounds = 12 } = {}) {
  const errors = []
  const email = String(o.email || '').trim().toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.push('--email must be an email address')
  const first = String(o.first || '').trim(); if (!first || first.length > 60) errors.push('--first (first name, shown to people) is required')
  const initial = String(o.initial || '').trim(); if (initial.length < 1 || initial.length > 2) errors.push('--initial must be 1 or 2 characters')
  const roles = String(o.roles || o.role || '').split(',').map(s => s.trim()).filter(Boolean)
  if (!roles.length || roles.some(r => !ALL.includes(r))) errors.push(`--role must be one of ${STAFF.join(', ')} (or --roles with a comma list from ${ALL.join(', ')})`)
  if (roles.length && !roles.some(r => STAFF.includes(r))) errors.push('this script is for staff accounts: include one of ' + STAFF.join(', '))
  if (errors.length) return { errors }
  const hash = bcrypt.hashSync(password, rounds)
  const sql = `insert into expert_accounts (email, password_hash, roles, status, enabled, display_first_name, display_initial)\nvalues (${q(email)}, ${q(hash)}, array[${[...new Set(roles)].map(q).join(', ')}], 'active', true, ${q(first)}, ${q(initial)})\non conflict (email) do nothing;   -- if the email already exists nothing changes; use the directory or SQL to edit that account\n`
  return { sql, password, email, roles: [...new Set(roles)] }
}

// AUDIT A1 pass 2 (item 1): a first password stops working after 72 hours if no second factor was set up. This prints the SQL that issues a fresh
// first password to such an account (only while it has no second factor), and restarts its clock (created_at is the clock).
//   node scripts/expert-staff-account.cjs --reissue --email you@example.com
function buildReissue(o, { password = newPassword(), rounds = 12 } = {}) {
  const email = String(o.email || '').trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { errors: ['--email must be an email address'] }
  const hash = bcrypt.hashSync(password, rounds)
  const sql = `update expert_accounts set password_hash = ${q(hash)}, created_at = now(), failed_logins = 0, locked_until = null, token_version = token_version + 1\nwhere email = ${q(email)} and totp_enabled_at is null;   -- only an account that has not set up its second factor; 0 rows means it already has (use the lost-phone procedure instead)\n`
  return { sql, password, email }
}

if (require.main === module) {
  const o0 = parse(process.argv.slice(2))
  if (o0.reissue) {
    const r = buildReissue(o0)
    if (r.errors) { console.error(r.errors.map(e => `error: ${e}`).join('\n')); process.exit(1) }
    console.log('-- Run this in the Supabase SQL editor:\n' + r.sql)
    console.log(`New first password for ${r.email}, shown ONCE. It works for 72 hours, until the second factor is set up:\n\n    ${r.password}\n`)
    process.exit(0)
  }
  const r = build(parse(process.argv.slice(2)))
  if (r.errors) { console.error(r.errors.map(e => `error: ${e}`).join('\n')); process.exit(1) }
  console.log('-- Run this in the Supabase SQL editor:\n' + r.sql)
  console.log(`First password for ${r.email} (${r.roles.join(', ')}), shown ONCE; it is not stored anywhere else:\n\n    ${r.password}\n`)
  console.log('Next: sign in at the expert site, set up the authenticator app, save the recovery codes, then change this password in Settings.')
}
module.exports = { build, buildReissue, parse, newPassword, STAFF, ALL }
