// A small STATEFUL in-memory stand-in for the slice of supabase-js this codebase
// uses — so tests can assert on what the database ENDS UP containing after a
// whole flow (webhook → settle → fulfil → refund), not just on which calls were
// made. Complements fakeSupabase.cjs (which records calls but keeps no state).
//
//   const world = createWorld({ payments: [...], scans: [...] })
//   world.db                 // pass wherever getSupabase() is stubbed
//   world.t.payments         // live rows
//   world.failNext('payments', 'select', { message: 'fetch failed' })   // inject an error once
//   world.unique.webhook_events = [['provider','event_key']]            // uniqueness rules
const { createFakeSupabase } = require('./fakeSupabase.cjs')

// LIKE / ILIKE as PostgREST takes them: `%` and `*` are wildcards (`*` because `%` needs URL-encoding), `_` is one character.
// Webhooks round 14: this double used to IGNORE like/ilike and compare `.not(col, 'like', pat)` to the pattern text, so every
// retention / scrub query built on them "matched" nothing in tests and passed whatever it deleted.
const likeRe = (pat, ci) => new RegExp('^' + String(pat).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/[%*]/g, '.*').replace(/_/g, '.') + '$', ci ? 'i' : '')
const likeHit = (v, pat, ci) => typeof v === 'string' && likeRe(pat, ci).test(v)

function matches(row, filters) {
  return filters.every(([op, col, val, val2]) => {
    // webhook_events.last_attempt_at (migration 0090) is NOT NULL DEFAULT now(), backfilled from received_at — rows seeded without it read as that.
    const v = row[col] === undefined && col === 'last_attempt_at' ? row.received_at : row[col]
    switch (op) {
      case 'eq':  return v === val
      case 'neq': return v !== val
      case 'in':  return val.includes(v)
      case 'is':  return val === null ? (v === null || v === undefined) : v === val
      case 'like':  return likeHit(v, val, false)
      case 'ilike': return likeHit(v, val, true)
      // .not(col, op, val) is stored as ['not', col, op, val]
      case 'not':
        if (val === 'like')  return !likeHit(v, val2, false)
        if (val === 'ilike') return !likeHit(v, val2, true)
        return val === 'is' && val2 === null ? (v !== null && v !== undefined) : v !== val2
      // jsonb array containment: every wanted object appears (as a subset) in the column's array
      case 'contains': {
        // ROUND-5: this double used to accept a JS array here, which is NOT what the real client does —
        // supabase-js turns an array into a Postgres array literal (`cs.{[object Object]}` for objects), so
        // the production query errored while every test passed. A jsonb containment operand must be a JSON
        // string; anything else fails loudly, as it does against PostgREST.
        if (typeof val !== 'string') throw Object.assign(new Error('invalid input syntax for type json (contains() needs a JSON string for a jsonb column)'), { code: '22P02' })
        let want
        try { want = JSON.parse(val) } catch (_) { throw Object.assign(new Error('invalid input syntax for type json'), { code: '22P02' }) }
        return Array.isArray(v) && Array.isArray(want) && want.every(w => v.some(x => x && typeof x === 'object' && Object.entries(w).every(([k, wv]) => x[k] === wv)))
      }
      case 'gt':  return v > val
      case 'gte': return v >= val
      case 'lt':  return v < val
      case 'lte': return v <= val
      default:    return true
    }
  })
}


// ── column projection ───────────────────────────────────────────────────────
// PostgREST returns ONLY the columns a select() names; this double used to hand back whole rows, so a query that forgot a column the
// code then read (webhooks round 13: sweepReversedPayments left out payments.user_id and reversePayment silently skipped the buyer
// email; the commission and orphan sweeps left out referral_source / currency) passed every test. Projection is on by default now:
// `world.projectColumns = false` opts a test out. Supported select grammar: `a, b`, `*`, `alias:col`, `json->>key` / `json->a->>b`
// (optionally aliased), and embedded relations `rel(...)` / `alias:rel!inner(...)` (the seeded row carries the related object).
const IDENT = /^[a-z_][a-z0-9_]*$/i
const splitTop = str => {
  const out = []; let depth = 0, cur = ''
  for (const ch of str) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = '' } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}
const jsonPath = (row, expr) => {
  const segs = expr.split(/->>|->/).map(x => x.trim())
  let v = row[segs[0]]
  for (const k of segs.slice(1)) { if (v == null) return null; v = v[k] }
  return v === undefined ? null : v
}
function projectRows(world, q, rows) {
  const cols = q.cols
  if (world.projectColumns === false || !cols || typeof cols !== 'string') return rows
  const parts = splitTop(cols)
  if (!parts.length || parts.includes('*')) return rows
  return rows.map(r => {
    const out = {}
    for (const x of parts) {
      let m
      if (IDENT.test(x)) out[x] = r[x]
      else if ((m = x.match(/^([a-z_][a-z0-9_]*):([a-z_][a-z0-9_]*)(![a-z_]+)?(\(.*\))?$/i))) out[m[1]] = r[m[2]]            // alias:col  /  alias:rel(...)
      else if ((m = x.match(/^([a-z_][a-z0-9_]*)(![a-z_]+)?\(.*\)$/i))) out[m[1]] = r[m[1]]                                  // rel(...)
      else if ((m = x.match(/^([a-z_][a-z0-9_]*):([a-z_][a-z0-9_]*(?:->>?[a-z0-9_]+)+)$/i))) out[m[1]] = jsonPath(r, m[2])      // alias:json->>key
      else if ((m = x.match(/^([a-z_][a-z0-9_]*(?:->>?[a-z0-9_]+)+)$/i))) out[m[1].split(/->>?/).pop()] = jsonPath(r, m[1])    // json->>key
      else throw new Error(`memoryDb: unsupported select expression "${x}" — extend projectRows`)
    }
    return out
  })
}

function createWorld(seed = {}) {
  const t = {}
  for (const [k, rows] of Object.entries(seed)) t[k] = rows.map(r => ({ ...r }))
  const failures = []
  const rpcs = {}
  const unique = {}       // table -> [[col,...], ...]
  const partialUnique = {} // table -> [{ cols, where(row) }]
  let n = 0

  const world = {
    t, unique, partialUnique, rpcs,
    failNext(table, op, error) { failures.push({ table, op, error }) },
    calls: [],
    touchUpdatedAt: ['scans', 'payments'],
    projectColumns: true,
  }

  const resolver = q => {
    world.calls.push(q)
    if (q.op === 'rpc') {
      const h = rpcs[q.name]
      return h ? h(q.args, world) : { data: null, error: null }
    }
    const fi = failures.findIndex(f => f.table === q.table && f.op === q.op)
    if (fi >= 0) return { data: null, error: failures.splice(fi, 1)[0].error }
    t[q.table] = t[q.table] || []
    const rows = t[q.table]

    if (q.op === 'select') {
      const hit = projectRows(world, q, rows.filter(r => matches(r, q.filters)).map(r => ({ ...r })))
      if (q.single) return hit.length ? { data: hit[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } }
      if (q.maybe)  return { data: hit[0] ?? null, error: null }
      return { data: hit, error: null }
    }
    if (q.op === 'insert') {
      const vals = Array.isArray(q.values) ? q.values : [q.values]
      const out = []
      for (const v of vals) {
        const row = { id: `${q.table}-${++n}`, ...v }
        for (const cols of unique[q.table] || [])
          if (rows.some(r => cols.every(c => r[c] === row[c])))
            return { data: null, error: { code: '23505', message: `duplicate key on ${q.table}(${cols.join(',')})` } }
        for (const { cols, where } of partialUnique[q.table] || [])
          if (where(row) && rows.some(r => where(r) && cols.every(c => r[c] === row[c])))
            return { data: null, error: { code: '23505', message: `duplicate key on ${q.table}(${cols.join(',')})` } }
        rows.push(row); out.push({ ...row })
      }
      if (!q.returning) return { data: null, error: null }
      const shown = projectRows(world, q, out)
      return q.single || q.maybe ? { data: shown[0], error: null } : { data: shown, error: null }
    }
    if (q.op === 'update') {
      const hit = rows.filter(r => matches(r, q.filters))
      // Emulates the set_updated_at trigger (0001) — fulfilment's "is the job lost?" check reads updated_at.
      hit.forEach(r => Object.assign(r, q.patch, world.touchUpdatedAt.includes(q.table) ? { updated_at: new Date().toISOString() } : {}))
      if (!q.returning) return { data: null, error: null }
      const copies = projectRows(world, q, hit.map(r => ({ ...r })))
      return q.single || q.maybe ? { data: copies[0] ?? null, error: null } : { data: copies, error: null }
    }
    if (q.op === 'upsert') {
      // INSERT ... ON CONFLICT (cols) DO UPDATE — conflict columns from onConflict, else the table's first unique rule.
      const cols = q.onConflict ? String(q.onConflict).split(',').map(x => x.trim()) : (unique[q.table] || [])[0]
      for (const v of Array.isArray(q.values) ? q.values : [q.values]) {
        const hit = cols && rows.find(r => cols.every(cn => r[cn] === v[cn]))
        if (hit) { if (!q.ignoreDuplicates) Object.assign(hit, v) }   // ON CONFLICT DO NOTHING when ignoreDuplicates
        else rows.push({ id: `${q.table}-${++n}`, created_at: new Date().toISOString(), ...v })
      }
      return { data: null, error: null }
    }
    if (q.op === 'delete') {
      const gone = rows.filter(r => matches(r, q.filters))
      t[q.table] = rows.filter(r => !matches(r, q.filters))
      // .delete()...select('id') returns what was removed, as PostgREST does.
      return { data: q.returning ? projectRows(world, q, gone.map(r => ({ ...r }))) : null, error: null }
    }
    return undefined
  }

  world.db = createFakeSupabase(resolver)
  return world
}

module.exports = { createWorld }
