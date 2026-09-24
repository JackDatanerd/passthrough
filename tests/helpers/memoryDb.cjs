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

function matches(row, filters) {
  return filters.every(([op, col, val, val2]) => {
    const v = row[col]
    switch (op) {
      case 'eq':  return v === val
      case 'neq': return v !== val
      case 'in':  return val.includes(v)
      case 'is':  return val === null ? (v === null || v === undefined) : v === val
      // .not(col, op, val) is stored as ['not', col, op, val]
      case 'not': return val === 'is' && val2 === null ? (v !== null && v !== undefined) : v !== val2
      // jsonb array containment: every wanted object appears (as a subset) in the column's array
      case 'contains': return Array.isArray(v) && val.every(w => v.some(x => x && typeof x === 'object' && Object.entries(w).every(([k, wv]) => x[k] === wv)))
      case 'gt':  return v > val
      case 'gte': return v >= val
      case 'lt':  return v < val
      case 'lte': return v <= val
      default:    return true
    }
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
      const hit = rows.filter(r => matches(r, q.filters)).map(r => ({ ...r }))
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
      return q.single || q.maybe ? { data: out[0], error: null } : { data: out, error: null }
    }
    if (q.op === 'update') {
      const hit = rows.filter(r => matches(r, q.filters))
      // Emulates the set_updated_at trigger (0001) — fulfilment's "is the job lost?" check reads updated_at.
      hit.forEach(r => Object.assign(r, q.patch, world.touchUpdatedAt.includes(q.table) ? { updated_at: new Date().toISOString() } : {}))
      if (!q.returning) return { data: null, error: null }
      const copies = hit.map(r => ({ ...r }))
      return q.single || q.maybe ? { data: copies[0] ?? null, error: null } : { data: copies, error: null }
    }
    if (q.op === 'delete') {
      const keep = rows.filter(r => !matches(r, q.filters))
      t[q.table] = keep
      return { data: null, error: null }
    }
    return undefined
  }

  world.db = createFakeSupabase(resolver)
  return world
}

module.exports = { createWorld }
