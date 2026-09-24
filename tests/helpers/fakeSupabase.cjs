// Chainable fake of the slice of the supabase-js query builder this codebase uses.
//
// Unlike the inline fakes the original tests used (which returned the same row no
// matter WHICH column or value was queried — so a bug in the lookup could never
// fail a test), this records every call. Tests can assert what was filtered on:
//
//   const db = createFakeSupabase(q => q.table === 'users' ? { data: row } : undefined)
//   ...
//   expect(eqValue(db.calls[0], 'code')).toBe('COACH20')
//
// `resolver(query)` receives { table, op, filters, patch, values, cols, single, maybe }
// (or { op:'rpc', name, args }) and returns { data, error } (or undefined -> empty success).

function createFakeSupabase(resolver = () => undefined) {
  const calls = []

  function from(table) {
    const q = { table, op: 'select', filters: [], orders: [], patch: null, values: null, cols: null, single: false, maybe: false, returning: false }
    const run = () => {
      calls.push(q)
      return Promise.resolve(resolver(q)).then(r => r ?? { data: null, error: null })
    }
    const api = {
      select(cols, opts) { q.cols = cols ?? '*'; q.selectOpts = opts || null; q.returning = true; return api },
      insert(values) { q.op = 'insert'; q.values = values; return api },
      update(patch) { q.op = 'update'; q.patch = patch; return api },
      delete() { q.op = 'delete'; return api },
      upsert(values) { q.op = 'upsert'; q.values = values; return api },
      order(col, opts) { q.orders.push([col, opts]); return api },
      limit() { return api },
      // range/or are recorded (q.range / q.or) so tests can assert on them;
      // before, they were silently dropped.
      range(from, to) { q.range = [from, to]; return api },
      or(expr) { (q.or = q.or || []).push(expr); return api },
      maybeSingle() { q.maybe = true; return run() },
      single() { q.single = true; return run() },
      then(resolve, reject) { return run().then(resolve, reject) },
    }
    for (const f of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'like', 'ilike'])
      api[f] = (col, val) => { q.filters.push([f, col, val]); return api }
    // .contains(col, [ {..} ]) — jsonb/array containment (@>)
    api.contains = (col, val) => { q.filters.push(['contains', col, val]); return api }
    api.not = (col, op, val) => { q.filters.push(['not', col, op, val]); return api }
    return api
  }

  function rpc(name, args) {
    const q = { table: null, op: 'rpc', name, args, filters: [] }
    calls.push(q)
    return Promise.resolve(resolver(q)).then(r => r ?? { data: null, error: null })
  }

  return { from, rpc, calls }
}

// Value of the first `.eq(col, value)` filter on a recorded query.
function eqValue(query, col) {
  const hit = (query.filters || []).find(f => f[0] === 'eq' && f[1] === col)
  return hit ? hit[2] : undefined
}

module.exports = { createFakeSupabase, eqValue }
