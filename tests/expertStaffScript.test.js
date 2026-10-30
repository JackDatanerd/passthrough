// Experts Phase 2A: the hand-made staff account script prints SQL with a hash, never the password, and refuses bad input.
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require_ = createRequire(import.meta.url)
const bcrypt = require_('bcryptjs')
const { build, parse, newPassword } = require_('../scripts/expert-staff-account.cjs')

describe('expert-staff-account', () => {
  it('prints one insert with a bcrypt hash that matches the printed password, and the password is not in the SQL', () => {
    const r = build(parse(['--email', 'Jack@Example.com', '--first', 'Jack', '--initial', 'K', '--role', 'expert_admin']), { rounds: 4 })
    expect(r.errors).toBeUndefined(); expect(r.sql).toContain("'jack@example.com'"); expect(r.sql).toContain("array['expert_admin']"); expect(r.sql).toContain("'active', true"); expect(r.sql).not.toContain(r.password)
    const hash = r.sql.match(/'(\$2[aby]\$[^']+)'/)[1]; expect(bcrypt.compareSync(r.password, hash)).toBe(true); expect(r.password.replace(/-/g, '').length).toBeGreaterThanOrEqual(24)
  })
  it('refuses a bad email, a missing name, a bad role, and a role list with no staff role', () => {
    for (const args of [['--email', 'nope', '--first', 'A', '--initial', 'A', '--role', 'expert_admin'], ['--email', 'a@b.co', '--initial', 'A', '--role', 'expert_admin'], ['--email', 'a@b.co', '--first', 'A', '--initial', 'A', '--role', 'root'],
      ['--email', 'a@b.co', '--first', 'A', '--initial', 'A', '--role', 'expert'], ['--email', 'a@b.co', '--first', 'A', '--initial', 'ABC', '--role', 'grader']]) expect(build(parse(args), { rounds: 4 }).errors?.length, args.join(' ')).toBeGreaterThan(0)
  })
  it('escapes quotes so a name cannot break out of the statement, and several roles are allowed', () => {
    const r = build(parse(['--email', 'a@b.co', '--first', "O'Brien", '--initial', 'B', '--roles', 'expert_support,grader']), { rounds: 4 }); expect(r.sql).toContain("'O''Brien'"); expect(r.sql).toContain("array['expert_support', 'grader']")
  })
  it('passwords are long and different every time', () => { expect(new Set(Array.from({ length: 20 }, newPassword)).size).toBe(20) })
})

describe('expert-staff-account --reissue (audit A1 pass 2)', () => {
  it('prints an update that only touches an account with no second factor, restarts its clock and never contains the password', () => {
    const { buildReissue } = require_('../scripts/expert-staff-account.cjs')
    const r = buildReissue({ email: 'Jack@Example.com' }, { rounds: 4 })
    expect(r.errors).toBeUndefined(); expect(r.sql).toContain("where email = 'jack@example.com' and totp_enabled_at is null"); expect(r.sql).toContain('created_at = now()'); expect(r.sql).toContain('token_version = token_version + 1'); expect(r.sql).not.toContain(r.password)
    expect(bcrypt.compareSync(r.password, r.sql.match(/'(\$2[aby]\$[^']+)'/)[1])).toBe(true)
    expect(buildReissue({ email: 'nope' }).errors.length).toBe(1)
  })
})
